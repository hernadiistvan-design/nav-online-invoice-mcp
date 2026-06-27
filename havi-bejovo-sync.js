import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;

function getRange() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  return { dateFrom: `${y}-01-01`, dateTo: today, label: `${y}` };
}

async function getMeglevoSorszamok() {
  try {
    const url = SHEET_URL + '?action=getSorszamok&tab=NAV+bejövő';
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      console.log(`Már meglévő számlák a Sheetben: ${data.length}`);
      return new Set(data);
    }
  } catch(e) {
    console.log('Meglévő számlák lekérése sikertelen:', e.message);
  }
  return new Set();
}

function parseRaw(res) {
  const txt = (res?.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("\n").trim();
  const jm = txt.match(/```json\n([\s\S]*?)\n```/);
  if (jm) { try { return JSON.parse(jm[1]); } catch(e) {} }
  try { return JSON.parse(txt); } catch(e) {}
  return { _raw: txt };
}

function findInvoices(obj, out=[]) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { obj.forEach(i => findInvoices(i, out)); return out; }
  if (obj.invoiceNumber !== undefined) { out.push(obj); return out; }
  for (const v of Object.values(obj)) findInvoices(v, out);
  return out;
}

async function postRow(row) {
  await fetch(SHEET_URL, {
    method:"POST",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify(row)
  });
}

async function main() {
  if (!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const { dateFrom, dateTo, label } = getRange();
  console.log(`Lekérendő: ${label} (${dateFrom} … ${dateTo}) - INBOUND`);

  const meglevo = await getMeglevoSorszamok();

  const transport = new StdioClientTransport({ command:"node", args:["dist/cli.js"], env:process.env });
  const client = new Client({ name:"nav-sync", version:"1.0.0" }, { capabilities:{} });
  await client.connect(transport);

  const tools = await client.listTools();
  const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
  console.log("Digest tool:", digestTool?.name);

  const invoices = [];
  let page = 1, totalPages = 1;
  do {
    const res = await client.callTool({
      name: digestTool.name,
      arguments: { invoiceDirection: "INBOUND", dateFrom, dateTo, page }
    });
    const data = parseRaw(res);
    const ap = data?.invoiceDigestResult?.availablePage
      ?? data?.result?.invoiceDigestResult?.availablePage ?? 1;
    totalPages = Math.min(Number(ap) || 1, 100);
    findInvoices(data?.invoiceDigestResult ?? data?.result?.invoiceDigestResult ?? data, invoices);
    page++;
  } while (page <= totalPages);

  console.log(`NAV-ból összesen: ${invoices.length}`);

  const ujak = invoices.filter(inv => {
    const sz = (inv.invoiceNumber || "").trim();
    return sz && !meglevo.has(sz);
  });

  console.log(`Új (még nem szerepel a Sheetben): ${ujak.length}`);
  if (ujak.length === 0) {
    console.log("Nincs új számla — kész.");
    await client.close();
    return;
  }

  const pmMap = { CASH:"készpénz", TRANSFER:"átutalás", CARD:"kártya", VOUCHER:"egyéb", OTHER:"egyéb" };
  let sent = 0;

  for (const inv of ujak) {
    const net   = Number(inv.invoiceNetAmount   || inv.invoiceNetAmountHUF   || 0);
    const vat   = Number(inv.invoiceVatAmount   || inv.invoiceVatAmountHUF   || 0);
    const gross = Number(inv.invoiceGrossAmount || inv.invoiceGrossAmountHUF || 0);
    const osszeg = gross || (net + vat) || 0;

    await postRow({
      datum:        inv.invoiceIssueDate || inv.issueDate || "",
      elado:        inv.supplierName || "",
      sorszam:      inv.invoiceNumber || "",
      fizetesi_mod: pmMap[inv.paymentMethod] || "",
      osszeg,
      penznem:      inv.currency || inv.currencyCode || "HUF",
      vevo:         process.env.NAV_TAX_NUMBER || "",
      fajl:         `NAV bejövő ${label}`,
    });
    sent++;
    await new Promise(r=>setTimeout(r,150));
  }

  console.log(`Beküldve: ${sent} új sor.`);
  await client.close();
}
main().catch(err => { console.error("HIBA:", err); process.exit(1); });
