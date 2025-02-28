import fetch from "node-fetch";
import logger from "./logger.mjs";
import { EBAY_BEARER_TOKEN } from "./config.mjs";

const MAX_LISTINGS_PER_CARD = 200;
const EBAY_BROWSE_SEARCH_ENDPOINT =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";

const ebayCache = new Map();

function buildSearchQuery(cardData) {
  return `${cardData.name} ${cardData.cardNumber} ${cardData.setName} -lot -bundle -japanese -korean -chinese`;
}

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

export { fetchSingleCardListings, fetchAllSingleCardListings };
