import fs from "fs";
import path from "path";

function truncateUrl(url, maxLength = 50) {
  if (url.length <= maxLength) return url;
  return url.substring(0, maxLength) + "...";
}

function exportSolutionToCsv(solution, filename) {
  const outputDir = path.resolve("output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const newFilepath = path.join(
    outputDir,
    filename.replace(".csv", `_${timestamp}.csv`)
  );

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

export { truncateUrl, exportSolutionToCsv };
