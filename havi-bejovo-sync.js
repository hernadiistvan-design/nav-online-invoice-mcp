import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;
const HONAP = (process.env.HONAP || "").trim();

function getMonths() {
  if (/^\d{4}$/.test(HONAP)) {
    const y = parseInt(HONAP);
    return Array.from({length:12},(_,i)=>({
      from:`${y}-${String(i+1).padStart(2,'0')}-01T00:00:00Z`,
      to:`${y}-${String(i+1).padStart(2,'0')}-${new Date(y,i+1,0).getDate()}T23:59:59Z`,
      label:`${y}-${String(i+1).padStart(2,'0')}`
    }));
  }
  if (/^\d{4}-\d{2}$/.test(HONAP)) {
    const [y,m] = HONAP.split("-").map(Number);
    return [{
      from:`${y}-${String(m).padStart(2,'0')}-01T00:00:00Z`,
      to:`${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}T23:59:59Z`,
      label:HONAP
    }];
  }
  const n = new Date();
  let y = n.getUTCFullYear(), m = n.getUTCMonth();
  if(m===0){m=12;y--;}
  return [{
    from:`${y}-${String(m).padStart(2,'0')}-01T00:00:00Z`,
    to:`${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}T23:59:59Z`,
    label:`${y}-${String(m).padStart(2,'0')}`
  }];
}

function pick(obj,names){
  if(!obj||typeof obj!=="object") return undefined;
  for(const k of Object.keys(obj)) if(names.includes(k)) return obj[k];
  for(const k of Object.keys(obj)){const r=pick(obj[k],names);if(r!==undefined)return r;}
  return undefined;
}
function collectInvoices(node,out=[]){
  if(!node||typeof node!=="object") return out;
  if(node.invoiceNumber!==undefined&&!Array.isArray(node)) out.push(node);
  for(const k of Object.keys(node)){
    const v=node[k];
    if(Array.isArray(v)) v.forEach(it=>collectInvoices(it,out));
    else if(typeof v==="object") collectInvoices(v,out);
  }
  return out;
}
function parseToolResult(res){
  const txt=(res?.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("\n").trim();
  if(!txt) return res?.structuredContent??{};
  try{return JSON.parse(txt);}catch{return{_raw:txt};}
}
async function postRow(row){
  await fetch(SHEET_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(row)});
}

async function main(){
  if(!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const months = getMonths();
  console.log(`Lekérendő időszakok: ${months.map(m=>m.label).join(", ")}`);

  const transport = new StdioClientTransport({command:"node",args:["dist/cli.js"],env:process.env});
  const client = new Client({name:"havi-bejovo-sync",version:"1.0.0"},{capabilities:{}});
  await client.connect(transport);

  const tools = await client.listTools();
  const digestTool = tools.tools.find(t=>/digest/i.test(t.name)&&/invoice/i.test(t.name));

  let totalSent = 0;
  for(const {from,to,label} of months){
    console.log(`\n--- ${label} ---`);
    const invoices=[];
    let page=1,totalPages=1;
    do{
      const res = await client.callTool({
        name:digestTool.name,
        arguments:{
          invoiceDirection:"INBOUND",
          insDateTimeFrom:from,
          insDateTimeTo:to,
          page
        }
      });
      const data = parseToolResult(res);
      console.log(`oldal ${page} válasz:`, JSON.stringify(data).slice(0,200));
      const ap = pick(data,["availablePage","availablePages"]);
      totalPages = Number(ap)||1;
      collectInvoices(data,invoices);
      page++;
    }while(page<=totalPages);

    console.log(`Talált: ${invoices.length}`);
    const pmMap={CASH:"készpénz",TRANSFER:"átutalás",CARD:"kártya",VOUCHER:"egyéb",OTHER:"egyéb"};
    for(const inv of invoices){
      const row={
        datum:pick(inv,["invoiceIssueDate","issueDate"])||"",
        elado:pick(inv,["supplierName"])||"",
        sorszam:pick(inv,["invoiceNumber"])||"",
        fizetesi_mod:pmMap[pick(inv,["paymentMethod"])]||"",
        osszeg:Number(pick(inv,["invoiceGrossAmount"]))||0,
        penznem:pick(inv,["currency","currencyCode"])||"HUF",
        vevo:process.env.NAV_TAX_NUMBER||"",
        fajl:`NAV bejövő ${label}`,
      };
      await postRow(row);
      totalSent++;
    }
    await new Promise(r=>setTimeout(r,300));
  }
  console.log(`\nÖsszesen beküldve: ${totalSent} sor.`);
  await client.close();
}
main().catch(err=>{console.error("HIBA:",err);process.exit(1);});
