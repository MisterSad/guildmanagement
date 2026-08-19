import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

async function generatePDF() {
  console.log("🚀 Starting PDF generation for Technical, Security & IP Compliance Whitepaper...");

  const templatePath = path.join(rootDir, "docs", "compliance-whitepaper-template.html");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found at ${templatePath}`);
  }

  const htmlContent = fs.readFileSync(templatePath, "utf-8");

  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "networkidle" });

  const rootPdfPath = path.join(rootDir, "FGF_Guild_Management_Technical_Security_IP_Compliance_Whitepaper.pdf");
  const docsPdfPath = path.join(rootDir, "docs", "FGF_Guild_Management_Technical_Security_IP_Compliance_Whitepaper.pdf");

  console.log("📄 Generating PDF via Playwright Chromium...");

  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: {
      top: "16mm",
      bottom: "16mm",
      left: "14mm",
      right: "14mm",
    },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; font-size: 7pt; color: #94a3b8; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between; border-bottom: 0.5px solid #e2e8f0; padding-bottom: 2px;">
        <span>FGF GUILD MANAGEMENT — TECHNICAL & IP COMPLIANCE WHITEPAPER</span>
        <span>REF: FGF-SEC-IP-COMPLIANCE-2026</span>
      </div>
    `,
    footerTemplate: `
      <div style="font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; font-size: 7pt; color: #94a3b8; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between; border-top: 0.5px solid #e2e8f0; padding-top: 2px;">
        <span>CONFIDENTIAL & PROPRIETARY — PREPARED FOR GAME PUBLISHER & AUDITORS</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `,
  });

  await browser.close();

  fs.writeFileSync(rootPdfPath, pdfBuffer);
  fs.writeFileSync(docsPdfPath, pdfBuffer);

  const stats = fs.statSync(rootPdfPath);
  console.log(`✅ PDF successfully generated!`);
  console.log(`📍 File locations:`);
  console.log(`   - ${rootPdfPath} (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log(`   - ${docsPdfPath} (${(stats.size / 1024).toFixed(1)} KB)`);
}

generatePDF().catch((err) => {
  console.error("❌ Error generating PDF:", err);
  process.exit(1);
});
