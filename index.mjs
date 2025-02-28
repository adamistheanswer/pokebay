import logger from "./src/logger.mjs";
import { buildMissingCards } from "./src/pokemonApi.mjs";
import { fetchAllSingleCardListings } from "./src/ebayApi.mjs";
import { buildIlpModel, solveIlp } from "./src/ilpModel.mjs";
import { truncateUrl, exportSolutionToCsv } from "./src/utils.mjs";

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

const MISSING_CARDS = await buildMissingCards(setsToFetch);

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
