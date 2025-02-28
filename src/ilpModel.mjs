import glpk from "glpk.js";
import logger from "./logger.mjs";

const solver = await glpk();

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

export { buildIlpModel, solveIlp };
