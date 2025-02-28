import fetch from "node-fetch";
import logger from "./logger.mjs";
import { POKEMON_TCG_API_KEY } from "./config.mjs";

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

export { getCardDataBySet, buildMissingCards };
