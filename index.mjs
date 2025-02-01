import glpk from "glpk.js";
const solver = await glpk();
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const EBAY_BEARER_TOKEN = process.env.EBAY_BEARER_TOKEN;
const POKEMON_TCG_API_KEY = process.env.POKEMON_TCG_API_KEY;

const MAX_LISTINGS_PER_CARD = 50;

const EBAY_BROWSE_SEARCH_ENDPOINT =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";

const setsToFetch = [
  {
    setId: "sv7", // Stellar Crown Set
    cardNumbers: [
      1, 14, 28, 30, 32, 41, 67, 82, 89, 105, 110, 128, 134, 136, 142,
    ],
  },
];

async function getCardDataBySetAndNumber(setId, cardNumber) {
  console.log(`Getting card ${cardNumber} data from set ${setId}`);
  const url = `https://api.pokemontcg.io/v2/cards?q=set.id:${setId} number:${cardNumber}`;

  const resp = await fetch(url, {
    headers: {
      "X-Api-Key": POKEMON_TCG_API_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Pokemon TCG API error: ${resp.status} => ${body}`);
  }

  const data = await resp.json();
  if (!data?.data || !data.data.length) {
    console.warn(`No results for setId=${setId}, cardNumber=${cardNumber}`);
    return null;
  }

  // Grab the first card
  const card = data.data[0];
  const originalNumber = card.number; // e.g. "160", "GG13/GG70", "210a"
  const setTotal = card.set.printedTotal ?? card.set.total; // e.g. 145

  // Attempt to parse the originalNumber as an integer
  let parsedNum = parseInt(originalNumber, 10); // NaN if cannot parse
  let formattedNumber;

  if (!isNaN(parsedNum) && setTotal) {
    // If successfully parsed, build something like "160/145" or zero-pad "001/145"
    const padded = String(parsedNum).padStart(3, "0"); // => "160" or "001"
    formattedNumber = `${padded}/${setTotal}`;
  } else {
    // If parse fails (NaN) or setTotal is missing, fall back to the original string
    formattedNumber = originalNumber;
  }

  return {
    name: card.name, // e.g. "Charizard"
    setName: card.set.name, // e.g. "Crown Zenith"
    cardNumber: formattedNumber, // e.g. "160/145" or "GG13/GG70"
  };
}

async function buildMissingCards(setsToFetch) {
  const results = [];

  for (const { setId, cardNumbers } of setsToFetch) {
    for (const number of cardNumbers) {
      console.log("");
      const cardInfo = await getCardDataBySetAndNumber(setId, number);
      if (cardInfo) {
        results.push(cardInfo);
      }
    }
  }
  return results;
}

// const MISSING_CARDS = [
//   { name: "Venusaur", setName: "Stellar Crown", cardNumber: "001/142" },
//   { name: "Lucario", setName: "Stellar Crown", cardNumber: "082/142" },
// ];

const MISSING_CARDS = await buildMissingCards(setsToFetch);

function buildSearchQuery(cardData) {
  // e.g. "Venusaur 001/142 Stellar Crown -lot -set -bundle"
  console.log(
    `Searching Ebay UK: ${cardData.name} ${cardData.cardNumber} ${cardData.setName}`
  );
  return `${cardData.name} ${cardData.cardNumber} ${cardData.setName} -lot -set -bundle`;
}

async function fetchSingleCardListings(cardData, limit = 10) {
  const query = encodeURIComponent(buildSearchQuery(cardData));
  const url =
    `${EBAY_BROWSE_SEARCH_ENDPOINT}?q=${query}&limit=${limit}` +
    `&filter=buyingOptions:{FIXED_PRICE},itemLocationCountry:GB`;

  const headers = {
    Authorization: `Bearer v^1.1${EBAY_BEARER_TOKEN}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Error ${response.status} from eBay: ${body}`);
    }

    const data = await response.json();
    const items = data.itemSummaries || [];

    return items.map((item) => {
      const listingId = item.itemId || item.epid || item.title;
      const seller = item.seller?.username || "UnknownSeller";
      const priceValue = parseFloat(item.price?.value || "0") || 0;
      let shippingCost = 0;

      if (Array.isArray(item.shippingOptions) && item.shippingOptions.length) {
        const shippingCostObj = item.shippingOptions[0]?.shippingCost;
        if (shippingCostObj?.value) {
          shippingCost = parseFloat(shippingCostObj.value);
        }
      }

      return {
        listingId,
        card: cardData.name,
        price: priceValue,
        shipping: shippingCost,
        seller,
        itemWebUrl: item.itemWebUrl || "",
      };
    });
  } catch (error) {
    // Fixed the reference here:
    console.error(
      `Error fetching listings for card "${cardData.name}": ${error.message}`
    );
    return [];
  }
}

async function fetchAllSingleCardListings(cards) {
  let allListings = [];
  for (const card of cards) {
    const listings = await fetchSingleCardListings(card, MAX_LISTINGS_PER_CARD);

    allListings = allListings.concat(listings);
  }
  return allListings;
}

function buildIlpModel(listings, missingCards) {
  console.log("Building ILP Model");
  const sellers = [...new Set(listings.map((l) => l.seller))];

  const listingVarIndex = {};
  const sellerVarIndex = {};

  const objectiveVars = []; // For objective function
  const subjectToConstraints = []; // For constraints
  const binaryVarNames = []; // For y & x variables

  // 1) x_l variables => For each listing
  listings.forEach((listing) => {
    const xName = `x_${listing.listingId}`;
    listingVarIndex[listing.listingId] = xName;

    // We want to minimize total cost: listing.price in the objective
    objectiveVars.push({ name: xName, coef: listing.price });

    // Mark xName as binary
    binaryVarNames.push(xName);
  });

  // 2) y_s variables => For each seller
  sellers.forEach((seller) => {
    const yName = `y_${seller}`;
    sellerVarIndex[seller] = yName;

    const sellerListings = listings.filter((l) => l.seller === seller);
    const maxShipping = Math.max(...sellerListings.map((l) => l.shipping), 0);

    // Add one-time shipping to the objective:
    objectiveVars.push({ name: yName, coef: maxShipping });

    // Mark yName as binary
    binaryVarNames.push(yName);
  });

  // 3) Constraints
  // (a) Exactly 1 listing per card
  missingCards.forEach((cardObj) => {
    const relevantListings = listings.filter((l) => l.card === cardObj.name);
    const constraintVars = relevantListings.map((listing) => ({
      name: listingVarIndex[listing.listingId], // the variable name, e.g. x_123
      coef: 1,
    }));

    subjectToConstraints.push({
      name: `exactly_one_${cardObj.name}`,
      vars: constraintVars,
      // exactly one => bnds: type GLP_FX with lb=1, ub=1
      bnds: { type: solver.GLP_FX, lb: 1, ub: 1 },
    });
  });

  // (b) Seller activation: x_l <= y_s  =>  x_l - y_s <= 0
  listings.forEach((listing) => {
    const xName = listingVarIndex[listing.listingId];
    const yName = sellerVarIndex[listing.seller];

    subjectToConstraints.push({
      name: `activation_${listing.listingId}`,
      vars: [
        { name: xName, coef: 1 },
        { name: yName, coef: -1 },
      ],
      // x_l - y_s <= 0 => type = GLP_UP, ub = 0
      bnds: { type: solver.GLP_UP, ub: 0, lb: 0 },
    });
  });

  // Now build the final model object:
  return {
    name: "CheapestPokemonBasket",
    objective: {
      direction: solver.GLP_MIN,
      name: "total_cost",
      vars: objectiveVars,
    },
    subjectTo: subjectToConstraints,
    binaries: binaryVarNames,
  };
}

function solveIlp(model, listings) {
  console.log("Solving Card ILP - Seller & Shipping Consideration");
  const result = solver.solve(model);

  if (result.result.status !== solver.GLP_OPT) {
    console.warn("No optimal solution found. status:", result.result.status);
    return null;
  }

  const chosenListings = [];
  const chosenSellers = [];
  for (const varName in result.result.vars) {
    const val = result.result.vars[varName];
    if (val > 0.5 && varName.startsWith("x_")) {
      // It's a chosen listing
      const listingId = varName.slice(2);
      const listing = listings.find((l) => l.listingId === listingId);
      if (listing) chosenListings.push(listing);
    }
    if (val > 0.5 && varName.startsWith("y_")) {
      chosenSellers.push(varName.slice(2));
    }
  }

  return {
    totalCost: result.result.z,
    chosenListings,
    chosenSellers,
  };
}

function exportSolutionToCsv(solution, filepath) {
  // Header row
  const header = ["Card", "Seller", "Price", "Shipping", "URL"].join(",");

  // Data rows
  const rows = solution.chosenListings.map((listing) => {
    // Escape quotes in case card names or sellers might contain commas
    const card = `"${listing.card.replace(/"/g, '""')}"`;
    const seller = `"${listing.seller.replace(/"/g, '""')}"`;
    const price = listing.price;
    const shipping = listing.shipping;
    const url = `"${listing.itemWebUrl.replace(/"/g, '""')}"`;

    return [card, seller, price, shipping, url].join(",");
  });

  // Combine header + rows
  const csvData = [header, ...rows].join("\n");

  // Write the file
  fs.writeFileSync(filepath, csvData, "utf-8");
}

function truncateUrl(url, maxLength = 50) {
  if (url.length <= maxLength) return url;
  return url.substring(0, maxLength) + "...";
}

async function main() {
  try {
    console.log("Fetching single-card listings from eBay...");
    const listings = await fetchAllSingleCardListings(MISSING_CARDS);
    console.log(`Fetched ${listings.length} listings.`);

    if (!listings.length) {
      console.log("No listings fetched. Exiting.");
      return;
    }

    console.log("Building ILP model...");
    const model = buildIlpModel(listings, MISSING_CARDS);

    console.log("Solving ILP...");
    const solution = solveIlp(model, listings);

    if (!solution) {
      console.log("No feasible/optimal solution found.");
      return;
    }

    console.log("\n=== Optimal Solution Found ===");
    console.log(`Total Combined Cost: £${solution.totalCost.toFixed(2)}`);
    console.log(`Chosen Sellers: ${solution.chosenSellers.join(", ")}`);

    console.log("\nChosen Listings:");
    console.table(
      solution.chosenListings.map((listing) => ({
        Card: listing.card,
        Seller: listing.seller,
        Price: `£${listing.price.toFixed(2)}`,
        Shipping: `£${listing.shipping.toFixed(2)}`,
        URL: truncateUrl(listing.itemWebUrl, 70),
      }))
    );

    console.log("Full eBay URLs:");
    solution.chosenListings.forEach((l, index) => {
      console.log(`${index + 1}) ${l.itemWebUrl}`);
    });

    console.log("===============================");

    exportSolutionToCsv(solution, "chosen_listings.csv");
  } catch (error) {
    console.error("Error in main:", error);
  }
}

main();
