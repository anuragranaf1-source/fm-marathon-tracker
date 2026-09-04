/**
 * /marathon-registration-alerts/ — Fatmarathoner.com
 *
 * Data sources:
 *   1. Single consolidated Google Sheets CSV (all races, Category column)
 *   2. status_summary.json committed by GitHub Actions (live registration status)
 *
 * Deploy via Cloudflare Pages + iframe embed in WordPress via WPCode.
 *
 * Env vars needed (.env or Cloudflare Pages environment variables):
 *   VITE_SHEET_URL          — published CSV URL for the consolidated All Races sheet
 *   VITE_STATUS_JSON_URL    — raw GitHub URL for snapshots/status_summary.json
 *   VITE_BREVO_API_KEY      — Brevo API key (contacts:write only)
 *   VITE_BREVO_LIST_ID      — Brevo list ID (default: 3)
 */

import { useState, useEffect, useMemo } from "react";

// ─── Config ──────────────────────────────────────────────────────────────────
const SHEET_URL =
  import.meta.env?.VITE_SHEET_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQyUy-9R1G6--HJ2yg3QQNWcj8qV4PNh_IxA40DOnIlgfXLyDW4gy9x8LYPrwqMdA/pub?gid=617825260&single=true&output=csv";

const STATUS_URL =
  import.meta.env?.VITE_STATUS_JSON_URL ||
  "https://raw.githubusercontent.com/anuragranaf1-source/fatmarathoner-alerts/main/snapshots/status_summary.json";

const BREVO_API_KEY  = import.meta.env?.VITE_BREVO_API_KEY  || "";
const BREVO_LIST_ID  = parseInt(import.meta.env?.VITE_BREVO_LIST_ID || "3");

// Category values exactly as they appear in column O of the sheet
const CATEGORIES = [
  "All",
  "India",
  "Europe",
  "Americas",
  "Asia Pacific",
  "Africa & Middle East",
];

// ─── CSV parser (handles quoted fields with commas inside) ───────────────────
function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(headers.map((h, i) => [h.trim(), (values[i] || "").trim()]));
    });
}

function parseCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const styles = {
    OPEN:    { label: "Open Now",  bg: "#d1fae5", color: "#065f46" },
    CLOSED:  { label: "Closed",    bg: "#fee2e2", color: "#991b1b" },
    UNKNOWN: { label: "Checking",  bg: "#f3f4f6", color: "#6b7280" },
  };
  const s = styles[status] || styles.UNKNOWN;
  return (
    <span style={{
      background: s.bg, color: s.color,
      padding: "3px 10px", borderRadius: 999,
      fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
      display: "inline-block",
    }}>
      {s.label}
    </span>
  );
}

// ─── Entry type badge ─────────────────────────────────────────────────────────
function EntryBadge({ type }) {
  if (!type) return null;
  const isLottery = /ballot|lottery/i.test(type);
  return (
    <span style={{
      background: isLottery ? "#ede9fe" : "#e0f2fe",
      color: isLottery ? "#5b21b6" : "#0369a1",
      padding: "2px 8px", borderRadius: 999,
      fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
      display: "inline-block", marginLeft: 6,
    }}>
      {isLottery ? "Ballot/Lottery" : "Open Entry"}
    </span>
  );
}

// ─── Country list ─────────────────────────────────────────────────────────────
const COUNTRIES = [
  "", "Afghanistan","Albania","Algeria","Argentina","Australia","Austria",
  "Belgium","Brazil","Canada","Chile","China","Colombia","Croatia",
  "Czech Republic","Denmark","Egypt","Ethiopia","Finland","France","Germany",
  "Ghana","Greece","Hong Kong","Hungary","India","Indonesia","Ireland",
  "Israel","Italy","Japan","Kenya","South Korea","Malaysia","Mexico",
  "Morocco","Netherlands","New Zealand","Nigeria","Norway","Pakistan",
  "Philippines","Poland","Portugal","Romania","Russia","Saudi Arabia",
  "South Africa","Spain","Sweden","Switzerland","Taiwan","Tanzania",
  "Thailand","Tunisia","Turkey","Uganda","Ukraine","United Arab Emirates",
  "United Kingdom","United States","Uruguay","Vietnam","Zimbabwe",
];

// ─── Main component ───────────────────────────────────────────────────────────
export default function MarathonRegistrationAlerts() {
  const [races,   setRaces]   = useState([]);
  const [statMap, setStatMap] = useState({});   // orgUrl → "OPEN"|"CLOSED"|"UNKNOWN"
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  const [lastRun, setLastRun] = useState("");

  const [category, setCategory] = useState("All");
  const [search,   setSearch]   = useState("");
  const [statusFilter, setStatusFilter] = useState("All"); // All | OPEN | CLOSED | UNKNOWN

  const [email,   setEmail]   = useState("");
  const [country, setCountry] = useState("");
  const [signed,  setSigned]  = useState(!!localStorage.getItem("fm_subscribed"));
  const [subMsg,  setSubMsg]  = useState("");
  const [subErr,  setSubErr]  = useState("");
  const [subLoading, setSubLoading] = useState(false);

  // ── Load data ───────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(false);
      try {
        // 1. Fetch CSV
        const csvResp = await fetch(SHEET_URL);
        if (!csvResp.ok) throw new Error("CSV fetch failed");
        const csvText = await csvResp.text();
        const rows = parseCsv(csvText).filter((r) => r["Race Name"]);
        setRaces(rows);

        // 2. Fetch live status
        try {
          const statResp = await fetch(STATUS_URL);
          if (statResp.ok) {
            const summary = await statResp.json();
            const map = {};
            let latest = "";
            summary.forEach((item) => {
              map[item.url] = item.status;
              if (!latest || item.checked > latest) latest = item.checked;
            });
            setStatMap(map);
            if (latest) {
              setLastRun(latest.slice(0, 16).replace("T", " ") + " UTC");
            }
          }
        } catch { /* status stays empty — all UNKNOWN */ }

      } catch {
        setError(true);
      }
      setLoading(false);
    }
    load();
  }, []);

  // ── Filtered races ──────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    return races.filter((r) => {
      const cat    = r["Category"] || "";
      const orgUrl = r["Official / Organizer URL"] || "";
      const s      = statMap[orgUrl] || "UNKNOWN";

      const matchCat    = category === "All" || cat === category;
      const matchStatus = statusFilter === "All" || s === statusFilter;
      const matchSearch = !search ||
        r["Race Name"]?.toLowerCase().includes(search.toLowerCase()) ||
        r["City"]?.toLowerCase().includes(search.toLowerCase());

      return matchCat && matchStatus && matchSearch;
    });
  }, [races, category, search, statusFilter, statMap]);

  // ── Counts ──────────────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = { OPEN: 0, CLOSED: 0, UNKNOWN: 0, total: races.length };
    races.forEach((r) => {
      const s = statMap[r["Official / Organizer URL"] || ""] || "UNKNOWN";
      c[s] = (c[s] || 0) + 1;
    });
    return c;
  }, [races, statMap]);

  // ── Subscribe ───────────────────────────────────────────────────────────────
  async function handleSubscribe() {
    setSubErr("");
    setSubMsg("");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSubErr("Please enter a valid email address.");
      return;
    }
    setSubLoading(true);
    try {
      const res = await fetch("https://api.brevo.com/v3/contacts", {
        method: "POST",
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          email,
          listIds: [BREVO_LIST_ID],
          updateEnabled: true,
          attributes: {
            COUNTRY: country,
            SOURCE: "tracker_inline_signup",
          },
        }),
      });
      if (res.status === 201 || res.status === 204) {
        setSigned(true);
        setSubMsg("You're in! We'll email you the day any race opens entries.");
        localStorage.setItem("fm_subscribed", "1");
      } else {
        const j = await res.json().catch(() => ({}));
        setSubErr(j.message || "Something went wrong. Please try again.");
      }
    } catch {
      setSubErr("Network error. Please try again.");
    }
    setSubLoading(false);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      maxWidth: 960,
      margin: "0 auto",
      padding: "16px 12px",
      color: "#111",
    }}>

      {/* ── Hero ── */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <h1 style={{ fontSize: "clamp(22px,5vw,34px)", fontWeight: 800, margin: "0 0 10px", lineHeight: 1.2 }}>
          Marathon Registration Alerts
        </h1>
        <p style={{ color: "#555", fontSize: 15, maxWidth: 560, margin: "0 auto 10px", lineHeight: 1.6 }}>
          We monitor {counts.total || "160+"} race organiser pages daily. Get an email
          the moment entries open — before spots sell out.
        </p>
        {lastRun && (
          <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>
            Last checked: {lastRun}
          </p>
        )}
      </div>

      {/* ── Stats bar ── */}
      {!loading && !error && (
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { label: "Open now",   val: counts.OPEN,    bg: "#d1fae5", fg: "#065f46", filter: "OPEN"    },
            { label: "Closed",     val: counts.CLOSED,  bg: "#fee2e2", fg: "#991b1b", filter: "CLOSED"  },
            { label: "Monitoring", val: counts.UNKNOWN, bg: "#f3f4f6", fg: "#4b5563", filter: "UNKNOWN" },
            { label: "Total races",val: counts.total,   bg: "#eff6ff", fg: "#1d4ed8", filter: "All"     },
          ].map((s) => (
            <button key={s.label}
              onClick={() => setStatusFilter(statusFilter === s.filter ? "All" : s.filter)}
              style={{
                background: statusFilter === s.filter ? s.fg : s.bg,
                color: statusFilter === s.filter ? "#fff" : s.fg,
                border: "none", borderRadius: 12, padding: "10px 18px",
                textAlign: "center", minWidth: 90, cursor: "pointer",
                transition: "all .15s",
              }}
            >
              <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1 }}>{s.val}</div>
              <div style={{ fontSize: 11, fontWeight: 600, marginTop: 3 }}>{s.label}</div>
            </button>
          ))}
        </div>
      )}

      {/* ── Email signup ── */}
      {!signed ? (
        <div style={{
          background: "#0f172a", borderRadius: 14,
          padding: "22px 24px", marginBottom: 28,
        }}>
          <p style={{ margin: "0 0 4px", fontWeight: 700, color: "#f1f5f9", fontSize: 16 }}>
            🏃 Get alerts the day registration opens
          </p>
          <p style={{ margin: "0 0 14px", color: "#94a3b8", fontSize: 13 }}>
            Free. No spam. We only email when a race you'd care about opens.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="email" placeholder="your@email.com" value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubscribe()}
              style={{
                flex: "2 1 180px", padding: "10px 14px",
                borderRadius: 8, border: "1px solid #334155",
                fontSize: 14, background: "#1e293b", color: "#f1f5f9",
                outline: "none",
              }}
            />
            <select value={country} onChange={(e) => setCountry(e.target.value)}
              style={{
                flex: "1 1 140px", padding: "10px 14px",
                borderRadius: 8, border: "1px solid #334155",
                fontSize: 14, background: "#1e293b", color: country ? "#f1f5f9" : "#64748b",
                appearance: "none", outline: "none",
              }}
            >
              <option value="">Country (optional)</option>
              {COUNTRIES.filter(Boolean).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <button onClick={handleSubscribe} disabled={subLoading}
              style={{
                background: "linear-gradient(135deg,#f97316,#ef4444)",
                color: "#fff", fontWeight: 700, border: "none",
                borderRadius: 8, padding: "10px 20px",
                fontSize: 14, cursor: "pointer", flex: "0 0 auto",
                opacity: subLoading ? .6 : 1,
              }}
            >
              {subLoading ? "Signing up…" : "Alert me"}
            </button>
          </div>
          {subErr && <p style={{ color: "#f87171", fontSize: 13, margin: "8px 0 0" }}>{subErr}</p>}
          <p style={{ fontSize: 11, color: "#475569", margin: "10px 0 0" }}>
            Unsubscribe any time. Your email is never sold or shared.
          </p>
        </div>
      ) : (
        <div style={{
          background: "#d1fae5", borderRadius: 12, padding: "14px 20px",
          marginBottom: 24, color: "#065f46", fontWeight: 700, fontSize: 15,
        }}>
          ✅ {subMsg || "You're subscribed! We'll email you when any race opens entries."}
        </div>
      )}

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text" placeholder="Search races…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: "1 1 180px", padding: "8px 14px",
            borderRadius: 8, border: "1.5px solid #e5e7eb",
            fontSize: 14, outline: "none",
          }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CATEGORIES.map((c) => (
            <button key={c} onClick={() => setCategory(c)} style={{
              padding: "7px 13px", borderRadius: 8, fontSize: 13,
              fontWeight: 600, cursor: "pointer", border: "none",
              background: category === c ? "#0f172a" : "#f3f4f6",
              color: category === c ? "#fff" : "#374151",
              transition: "all .15s",
            }}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* ── Race count ── */}
      {!loading && !error && (
        <p style={{ color: "#6b7280", fontSize: 13, margin: "0 0 12px" }}>
          Showing {visible.length} of {races.length} races
          {category !== "All" ? ` in ${category}` : ""}
          {statusFilter !== "All" ? ` · ${statusFilter.toLowerCase()}` : ""}
          {search ? ` · matching "${search}"` : ""}
        </p>
      )}

      {/* ── Loading / error ── */}
      {loading && (
        <div style={{ textAlign: "center", padding: 60, color: "#9ca3af" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          Loading race data…
        </div>
      )}
      {error && (
        <div style={{
          textAlign: "center", padding: 40, color: "#991b1b",
          background: "#fee2e2", borderRadius: 12,
        }}>
          Failed to load race data. Please refresh the page.
        </div>
      )}

      {/* ── Race table ── */}
      {!loading && !error && (
        <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid #e5e7eb" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#f9fafb", borderBottom: "2px solid #e5e7eb" }}>
                {["Race", "Category", "Date", "Entry Type", "Status", "Register", "FM Guide"].map((h) => (
                  <th key={h} style={{
                    padding: "11px 14px", textAlign: "left",
                    fontWeight: 700, color: "#374151", whiteSpace: "nowrap",
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                const orgUrl = r["Official / Organizer URL"];
                const fmUrl  = r["FM Guide URL"];
                const s      = statMap[orgUrl] || "UNKNOWN";
                const isEven = i % 2 === 0;
                return (
                  <tr key={i}
                    style={{ background: isEven ? "#fff" : "#fafafa", borderBottom: "1px solid #f3f4f6" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#f0f9ff"}
                    onMouseLeave={(e) => e.currentTarget.style.background = isEven ? "#fff" : "#fafafa"}
                  >
                    <td style={{ padding: "11px 14px", fontWeight: 600, minWidth: 160 }}>
                      {r["Race Name"]}
                    </td>
                    <td style={{ padding: "11px 14px", color: "#6b7280", whiteSpace: "nowrap" }}>
                      {r["Category"] || "—"}
                    </td>
                    <td style={{ padding: "11px 14px", color: "#6b7280", whiteSpace: "nowrap" }}>
                      {r["Race Date"] || "—"}
                    </td>
                    <td style={{ padding: "11px 14px", whiteSpace: "nowrap" }}>
                      <EntryBadge type={r["Entry Type"]} />
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      <StatusBadge status={s} />
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      {orgUrl ? (
                        <a href={orgUrl} target="_blank" rel="noopener noreferrer"
                          style={{ color: "#e03d3d", textDecoration: "none", fontWeight: 600 }}>
                          Register →
                        </a>
                      ) : (
                        <span style={{ color: "#d1d5db" }}>TBA</span>
                      )}
                    </td>
                    <td style={{ padding: "11px 14px" }}>
                      {fmUrl ? (
                        <a href={fmUrl} target="_blank" rel="noopener noreferrer"
                          style={{ color: "#6b7280", textDecoration: "none", fontSize: 13 }}>
                          Guide ↗
                        </a>
                      ) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {visible.length === 0 && (
            <div style={{ textAlign: "center", padding: 40, color: "#9ca3af" }}>
              No races match your current filters.
              <br />
              <button onClick={() => { setCategory("All"); setSearch(""); setStatusFilter("All"); }}
                style={{
                  marginTop: 12, background: "none", border: "1px solid #d1d5db",
                  borderRadius: 8, padding: "6px 16px", cursor: "pointer",
                  fontSize: 13, color: "#374151",
                }}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Footer ── */}
      <p style={{ color: "#9ca3af", fontSize: 12, textAlign: "center", marginTop: 24, lineHeight: 1.6 }}>
        Registration status checked daily by an automated script. Always verify on the official race website before entering.
        <br />
        <a href="https://fatmarathoner.com/" style={{ color: "#9ca3af" }}>Fatmarathoner.com</a>
        {" · "}
        <a href="https://fatmarathoner.com/privacy-policy/" style={{ color: "#9ca3af" }}>Privacy policy</a>
      </p>
    </div>
  );
}
