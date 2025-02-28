import dotenv from "dotenv";

dotenv.config();

const EBAY_BEARER_TOKEN = process.env.EBAY_BEARER_TOKEN;
const POKEMON_TCG_API_KEY = process.env.POKEMON_TCG_API_KEY;

if (!EBAY_BEARER_TOKEN || !POKEMON_TCG_API_KEY) {
  throw new Error("Missing required environment variables.");
}

export { EBAY_BEARER_TOKEN, POKEMON_TCG_API_KEY };
