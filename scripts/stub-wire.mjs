// Standalone NewsMCP stub, for UI work and demos without spending the shared
// keyless budget (20 calls an hour, per network address).
//
//   node scripts/stub-wire.mjs 4399
//   NEWSMCP_URL=http://127.0.0.1:4399/mcp npm start
import http from "node:http";

const port = Number(process.argv[2] || 4399);
let served = 0;

const STORIES = [
  {
    headline: "Port of Oakland Halts Night Shifts After Crane Failure",
    abstract:
      "Terminal operators suspended overnight loading at the Port of Oakland after a gantry crane failed during a container transfer. No injuries were reported. Two federal agencies are reviewing maintenance records, and carriers have begun diverting to Long Beach.",
    sector: "transport_logistics",
    event_type: "accidents_disasters.industrial_accident",
    entities: ["Port of Oakland", "Occupational Safety and Health Administration"],
  },
  {
    headline: "Regional Bank Merger Clears Antitrust Review",
    abstract:
      "Federal regulators approved a merger between two mid-sized regional banks, creating the ninth-largest retail lender in the country. Consumer groups objected that branch closures will fall hardest on rural counties.",
    sector: "banking",
    event_type: "deals.merger_acquisition",
    entities: ["Federal Reserve", "Department of Justice"],
  },
  {
    headline: "Chipmaker Delays Next-Generation Fab by Two Quarters",
    abstract:
      "A leading semiconductor manufacturer pushed the opening of its new fabrication plant to the second half of next year, citing tooling delays and a shortage of qualified technicians. The plant is a condition of several state subsidies.",
    sector: "semiconductors",
    event_type: "corporate.production_delay",
    entities: ["Commerce Department"],
  },
  {
    headline: "Heat Wave Pushes Regional Grid to Record Demand",
    abstract:
      "The grid operator recorded its highest ever evening demand during a prolonged heat wave, holding off rolling blackouts by drawing on battery storage. Officials asked residents to delay laundry and charging until after nine at night.",
    sector: "energy_utilities",
    event_type: "environment.extreme_weather",
    entities: ["National Weather Service"],
  },
  {
    headline: "Union Files for Election at Three Distribution Centers",
    abstract:
      "Warehouse workers at three distribution centers filed for union elections, the largest single filing at the company to date. Management said it would respect the process; organizers allege earlier retaliation.",
    sector: "labor",
    event_type: "labor.union_action",
    entities: ["National Labor Relations Board"],
  },
  {
    headline: "Court Blocks Rule Limiting Overdraft Fees",
    abstract:
      "A federal appeals court paused a rule capping overdraft fees at large banks while a challenge proceeds. The regulator said it would seek an expedited hearing. The cap had been due to take effect next month.",
    sector: "banking",
    event_type: "legal.court_ruling",
    entities: ["Consumer Financial Protection Bureau"],
  },
  {
    headline: "Measles Cases Climb in Two Neighboring Counties",
    abstract:
      "Public health officials confirmed a cluster of measles cases across two counties, most among unvaccinated school-age children. Clinics extended weekend hours. No deaths have been reported.",
    sector: "health",
    event_type: "health.disease_outbreak",
    entities: ["Centers for Disease Control and Prevention"],
  },
  {
    headline: "City Council Approves Downtown Housing Overhaul",
    abstract:
      "Council members voted to allow taller residential buildings across the downtown core, ending a decade of height limits. Developers welcomed it; neighborhood groups said parking and school capacity were not addressed.",
    sector: "real_estate",
    event_type: "policy.zoning_change",
    entities: [],
  },
];

function events(args) {
  const now = new Date();
  const list = STORIES.map((s, i) => ({
    event_id: `evt_stub_${i}`,
    headline: s.headline,
    abstract: s.abstract,
    entities: s.entities.map((name, j) => ({ name, salience: j === 0 ? 0.9 : 0.5 })),
    sources: [
      `https://apnews.com/article/stub-${i}`,
      `https://www.reuters.com/stub-${i}`,
      `https://www.theguardian.com/stub-${i}`,
    ],
    event_type: s.event_type,
    content_type: "news_report",
    sector: s.sector,
    confidence: 0.9,
    reports: 60 - i * 4,
    newsrooms: 40 - i * 3,
    first_seen: new Date(now.getTime() - (i + 1) * 3600000).toISOString(),
    last_seen: new Date(now.getTime() - i * 600000).toISOString(),
  }));
  return { total: list.length, events: list.slice(0, args.limit ?? 20) };
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body || "{}");
      if (rpc.method === "notifications/initialized") return void res.writeHead(202).end();
      let result;
      if (rpc.method === "initialize") {
        res.setHeader("mcp-session-id", "stub");
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub-wire", version: "1" } };
      } else if (rpc.params?.name === "check_limits") {
        result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              plan: "stub",
              retry_after: 0,
              calls_per_hour: { limit: 20, left: 20 - served, reset_in: 1800 },
              max_concurrent: 1,
              lookback_days: 7,
              max_events: 20,
            }),
          },
        ],
      };
      } else if (rpc.params?.name === "news") {
        served += 1;
        console.log(`[stub-wire] news #${served} ${JSON.stringify(rpc.params.arguments)}`);
        result = { content: [{ type: "text", text: JSON.stringify(events(rpc.params.arguments)) }] };
      } else {
        result = { content: [{ type: "text", text: "{}" }] };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`[stub-wire] http://127.0.0.1:${port}/mcp`));
