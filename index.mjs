import glpk from "glpk.js";
const solver = await glpk();
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import { createLogger, transports, format } from "winston";

dotenv.config();

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.printf(
      ({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "pokebay.log" }),
  ],
});

const EBAY_BEARER_TOKEN = process.env.EBAY_BEARER_TOKEN;
const POKEMON_TCG_API_KEY = process.env.POKEMON_TCG_API_KEY;

if (!EBAY_BEARER_TOKEN || !POKEMON_TCG_API_KEY) {
  logger.error("Missing required environment variables.");
  process.exit(1);
}

const MAX_LISTINGS_PER_CARD = 200;
const EBAY_BROWSE_SEARCH_ENDPOINT =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";

const setsToFetch = [
  {
    setId: "sv8", // Surging Sparks set
    cardNumbers: [
      4, 48, 57, 68, 86, 91, 119, 130, 133, 162, 164, 176, 182, 183, 185,
    ],
  },
  {
    setId: "sv7", // Stellar Crown Set
    cardNumbers: [
      14, 28, 32, 41, 82, 128, 143, 144, 146, 147, 148, 150, 151, 152, 154, 155,
      156, 157, 162, 163, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
    ],
  },
  {
    setId: "sv5", // Temporal Forces Set
    cardNumbers: [
      11, 12, 22, 25, 34, 38, 50, 60, 104, 108, 111, 120, 122, 123, 141, 152,
      153, 154, 157, 158, 159, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171,
      172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185,
    ],
  },
];

async function getCardDataBySet(setId, cardNumbers) {
  logger.info(`Fetching multiple cards from set ${setId}`);

  const numberQueries = cardNumbers.map((num) => `number:${num}`).join(" OR ");
  const url = `https://api.pokemontcg.io/v2/cards?q=set.id:${setId} (${numberQueries})`;

  try {
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
      logger.warn(`No results for setId=${setId}`);
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
  } catch (error) {
    logger.error(`Error fetching card data for set ${setId}: ${error.message}`);
    return [];
  }
}

async function buildMissingCards(setsToFetch) {
  const results = [];

  for (const { setId, cardNumbers } of setsToFetch) {
    logger.info(`Fetching set: ${setId}`);
    const cards = await getCardDataBySet(setId, cardNumbers);
    results.push(...cards);
  }

  return results;
}

const MISSING_CARDS = await buildMissingCards(setsToFetch);

function buildSearchQuery(cardData) {
  return `${cardData.name} ${cardData.cardNumber} ${cardData.setName} -lot -bundle -japanese -korean -chinese`;
}

const ebayCache = new Map();

async function fetchSingleCardListings(cardData, limit = 10) {
  const query = buildSearchQuery(cardData);

  if (ebayCache.has(query)) {
    logger.info(`Using cached results for ${query}`);
    return ebayCache.get(query);
  }

  const encodedQuery = encodeURIComponent(query);
  const url = `${EBAY_BROWSE_SEARCH_ENDPOINT}?q=${encodedQuery}&limit=${limit}&filter=buyingOptions:{FIXED_PRICE},itemLocationCountry:GB`;

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
      cardNumber: cardData.cardNumber,
      price: parseFloat(item.price?.value || "0") || 0,
      shipping: parseFloat(
        item.shippingOptions?.[0]?.shippingCost?.value || "0"
      ),
      seller: item.seller?.username || "UnknownSeller",
      itemWebUrl: item.itemWebUrl || "",
    }));

    ebayCache.set(query, listings);

    return listings;
  } catch (error) {
    logger.error(
      `Error fetching listings for "${cardData.name}": ${error.message}`
    );
    return [];
  }
}

async function fetchAllSingleCardListings(cards) {
  logger.info(`Fetching listings for ${cards.length} cards in parallel...`);

  const listingsArray = await Promise.all(
    cards.map((card) => fetchSingleCardListings(card, MAX_LISTINGS_PER_CARD))
  );

  return listingsArray.flat();
}

function buildIlpModel(listings, missingCards) {
  logger.info("Building ILP Model");

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
  logger.info("Solving Card ILP - Seller & Shipping Consideration");
  const result = solver.solve(model);

  if (result.result.status !== solver.GLP_OPT) {
    logger.warn("No optimal solution found. status:", result.result.status);
    return null;
  }

  const chosenListings = [];
  const chosenSellers = [];
  for (const varName in result.result.vars) {
    const val = result.result.vars[varName];
    if (val > 0.5 && varName.startsWith("x_")) {
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newFilepath = filepath.replace(".csv", `_${timestamp}.csv`);

  const header = ["Card", "Seller", "Price", "Shipping", "URL"].join(",");

  const rows = solution.chosenListings.map((listing) => {
    const card = `"${listing.card.replace(/"/g, '""')}"`;
    const seller = `"${listing.seller.replace(/"/g, '""')}"`;
    const price = listing.price;
    const shipping = listing.shipping;
    const url = `"${listing.itemWebUrl.replace(/"/g, '""')}"`;

    return [card, seller, price, shipping, url].join(",");
  });

  const csvData = [header, ...rows].join("\n");

  fs.writeFileSync(newFilepath, csvData, "utf-8");
}

function truncateUrl(url, maxLength = 50) {
  if (url.length <= maxLength) return url;
  return url.substring(0, maxLength) + "...";
}

async function main() {
  try {
    logger.info("Fetching single-card listings from eBay...");
    const listings = await fetchAllSingleCardListings(MISSING_CARDS);
    logger.info(`Fetched ${listings.length} listings.`);

    if (!listings.length) {
      logger.info("No listings fetched. Exiting.");
      return;
    }

    logger.info("Building ILP model...");
    const model = buildIlpModel(listings, MISSING_CARDS);

    logger.info("Solving ILP...");
    const solution = solveIlp(model, listings);

    if (!solution) {
      logger.info("No feasible/optimal solution found.");
      return;
    }

    logger.info("\n=== Optimal Solution Found ===");
    logger.info(`Total Combined Cost: £${solution.totalCost.toFixed(2)}`);
    logger.info(`Chosen Sellers: ${solution.chosenSellers.join(", ")}`);

    logger.info("\nChosen Listings:");
    console.table(
      solution.chosenListings
        .sort((a, b) => a.seller.localeCompare(b.seller))
        .map((listing) => ({
          Card: `${listing.card} (${listing.cardNumber})`,
          Seller: listing.seller,
          Price: `£${listing.price.toFixed(2)}`,
          Shipping: `£${listing.shipping.toFixed(2)}`,
          URL: truncateUrl(listing.itemWebUrl, 70),
        }))
    );

    logger.info("===============================");

    exportSolutionToCsv(solution, "chosen_listings.csv");
  } catch (error) {
    logger.error("Error in main:", error);
  }
}

main();
