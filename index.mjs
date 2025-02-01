import glpk from "glpk.js";
const solver = await glpk();
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const EBAY_BEARER_TOKEN = process.env.EBAY_BEARER_TOKEN;
const POKEMON_TCG_API_KEY = process.env.POKEMON_TCG_API_KEY;

const MAX_LISTINGS_PER_CARD = 200;

const EBAY_BROWSE_SEARCH_ENDPOINT =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";

const setsToFetch = [
  {
    setId: "sv7", // Stellar Crown Set
    cardNumbers: [
      1, 14, 28, 30, 32, 41, 67, 82, 89, 105, 110, 128, 134, 136, 142,
    ],
  },
  {
    setId: "sv5", // Temporal Forces Set
    cardNumbers: [
      3, 4, 9, 10, 11, 12, 18, 19, 22, 25, 27, 33, 34, 35, 36, 38, 39, 40, 44,
      45, 46, 47, 49, 50, 51, 54, 60, 61, 63, 64, 65, 67, 74, 78, 80, 81, 82,
      83, 84, 87, 91, 92, 96, 99, 100, 101,
    ],
  },
];

async function getCardDataBySet(setId, cardNumbers) {
  console.log(`Fetching multiple cards from set ${setId}`);

  // Construct the query for multiple cards using OR
  const numberQueries = cardNumbers.map((num) => `number:${num}`).join(" OR ");
  const url = `https://api.pokemontcg.io/v2/cards?q=set.id:${setId} (${numberQueries})`;

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
    console.warn(`No results for setId=${setId}`);
    return [];
  }

  return data.data.map((card) => {
    const originalNumber = card.number;
    const setTotal = card.set.printedTotal ?? card.set.total;

    let parsedNum = parseInt(originalNumber, 10);
    let formattedNumber =
      !isNaN(parsedNum) && setTotal
        ? `${String(parsedNum).padStart(3, "0")}/${setTotal}`
        : originalNumber;

    return {
      name: card.name,
      setName: card.set.name,
      cardNumber: formattedNumber,
    };
  });
}

async function buildMissingCards(setsToFetch) {
  const results = [];

  for (const { setId, cardNumbers } of setsToFetch) {
    console.log(`Fetching set: ${setId}`);
    const cards = await getCardDataBySet(setId, cardNumbers);
    results.push(...cards);
  }

  return results;
}

const MISSING_CARDS = await buildMissingCards(setsToFetch);

function buildSearchQuery(cardData) {
  return `${cardData.name} ${cardData.cardNumber} ${cardData.setName} -lot -set -bundle -japanese -korean -chinese`;
}

const ebayCache = new Map();

async function fetchSingleCardListings(cardData, limit = 10) {
  const query = buildSearchQuery(cardData);

  // Check if we've already fetched this query
  if (ebayCache.has(query)) {
    console.log(`Using cached results for ${query}`);
    return ebayCache.get(query);
  }

  const encodedQuery = encodeURIComponent(query);
  const url =
    `${EBAY_BROWSE_SEARCH_ENDPOINT}?q=${encodedQuery}&limit=${limit}` +
    `&filter=buyingOptions:{FIXED_PRICE},itemLocationCountry:GB`;

  const headers = {
    Authorization: `Bearer v^1.1${EBAY_BEARER_TOKEN}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `Error ${response.status} from eBay: ${await response.text()}`
      );
    }

    const data = await response.json();
    const items = data.itemSummaries || [];

    const listings = items.map((item) => ({
      listingId: item.itemId || item.epid || item.title,
      card: cardData.name,
      price: parseFloat(item.price?.value || "0") || 0,
      shipping: parseFloat(
        item.shippingOptions?.[0]?.shippingCost?.value || "0"
      ),
      seller: item.seller?.username || "UnknownSeller",
      itemWebUrl: item.itemWebUrl || "",
    }));

    // Cache the result
    ebayCache.set(query, listings);

    return listings;
  } catch (error) {
    console.error(
      `Error fetching listings for "${cardData.name}":`,
      error.message
    );
    return [];
  }
}

async function fetchAllSingleCardListings(cards) {
  console.log(`Fetching listings for ${cards.length} cards in parallel...`);

  const listingsArray = await Promise.all(
    cards.map((card) => fetchSingleCardListings(card, MAX_LISTINGS_PER_CARD))
  );

  return listingsArray.flat();
}

function buildIlpModel(listings, missingCards) {
  console.log("Building ILP Model");

  const sellers = new Set();
  const listingVarIndex = {};
  const sellerVarIndex = {};
  const objectiveVars = [];
  const subjectToConstraints = [];
  const binaryVarNames = [];

  listings.forEach((listing) => {
    const xName = `x_${listing.listingId}`;
    listingVarIndex[listing.listingId] = xName;
    binaryVarNames.push(xName);
    objectiveVars.push({ name: xName, coef: listing.price });
    sellers.add(listing.seller);
  });

  [...sellers].forEach((seller) => {
    const yName = `y_${seller}`;
    sellerVarIndex[seller] = yName;
    binaryVarNames.push(yName);
  });

  missingCards.forEach((cardObj) => {
    const relevantListings = listings.filter((l) => l.card === cardObj.name);
    if (relevantListings.length === 0) return;

    subjectToConstraints.push({
      name: `exactly_one_${cardObj.name}`,
      vars: relevantListings.map((listing) => ({
        name: listingVarIndex[listing.listingId],
        coef: 1,
      })),
      bnds: { type: solver.GLP_FX, lb: 1, ub: 1 },
    });
  });

  listings.forEach((listing) => {
    const xName = listingVarIndex[listing.listingId];
    const yName = sellerVarIndex[listing.seller];

    subjectToConstraints.push({
      name: `activation_${listing.listingId}`,
      vars: [
        { name: xName, coef: 1 },
        { name: yName, coef: -1 },
      ],
      bnds: { type: solver.GLP_UP, ub: 0 },
    });
  });

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
