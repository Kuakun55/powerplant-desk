#!/usr/bin/env node
/**
 * Pulls recently published Airworthiness Directives relevant to the
 * fleet from official sources — EASA (Airbus) and FAA (Boeing) — and
 * writes a static snapshot to data/official-ads.json for the web app
 * to cross-reference against the AD Management tab.
 *
 * No official EASA API exists; ad.easa.europa.eu's search form posts
 * to /search/simple/result/page-N/ with fi_keyword, returning server
 * rendered HTML. FAA ADs are pulled from the official Federal Register
 * API (federalregister.gov), which is stable and documented.
 *
 * Zero npm dependencies on purpose, so the GitHub Action needs no
 * install step.
 */

const EASA_KEYWORDS = ["A320", "A321", "CFM56-5B", "APS3200"];
const FAA_KEYWORDS  = ["737 MAX", "LEAP-1B"];
const UA = "Mozilla/5.0 (compatible; PowerplantDeskADWatcher/1.0)";
const MAX_PAGES_PER_KEYWORD = 5; // safety cap, ~100 results/keyword

function stripTags(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchEasaPage(keyword, page) {
  const url = `https://ad.easa.europa.eu/search/simple/result/page-${page}/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: `fi_action=simple&fi_keyword=${encodeURIComponent(keyword)}`,
  });
  if (!res.ok) throw new Error(`EASA search failed (${res.status}) for "${keyword}" page ${page}`);
  return res.text();
}

function parseEasaRows(html) {
  const rows = [];
  const rowChunks = html.split(/<tr\b/).slice(1); // drop header/preamble
  for (const chunk of rowChunks) {
    const refMatch = chunk.match(/<a href="([^"]+)" class="easa_cd">([^<]+)<\/a>/);
    if (!refMatch) continue; // not a data row
    const dateCells = [...chunk.matchAll(/<td class="cell-date">([\s\S]*?)<\/td>/g)].map(m => stripTags(m[1]));
    // subject cell has "<br>send comment" trailing — keep only the text before that
    const defaultCells = [...chunk.matchAll(/<td class="cell-default">([\s\S]*?)<\/td>/g)].map(m => stripTags(m[1].split(/<br\s*\/?>/i)[0]));
    const tcHolders = [...chunk.matchAll(/<li class="tc_holder"[^>]*>\s*([^<]+)/g)].map(m => m[1].trim());
    const types = [...chunk.matchAll(/<li class="type"[^>]*>\s*([^<]+)/g)].map(m => m[1].trim());
    // dateCells[0] is the ref-number cell itself (the <a> text survives stripTags);
    // dateCells[1] is the issue date, dateCells[2] the effective date.
    rows.push({
      source: "EASA",
      ref: refMatch[2].trim(),
      url: refMatch[1],
      issueDate: dateCells[1] || "",
      subject: defaultCells[1] || defaultCells[0] || "",
      tcHolders,
      types,
      effectiveDate: dateCells[2] || "",
    });
  }
  return rows;
}

async function fetchEasaKeyword(keyword) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page++) {
    const html = await fetchEasaPage(keyword, page);
    const rows = parseEasaRows(html);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 20) break; // last page (20 per page normally)
  }
  return all;
}

async function fetchFaaKeyword(keyword) {
  const params = new URLSearchParams();
  params.append("conditions[agencies][]", "federal-aviation-administration");
  params.append("conditions[term]", keyword);
  params.append("conditions[type][]", "RULE");
  params.append("per_page", "100");
  params.append("order", "newest");
  const url = `https://www.federalregister.gov/api/v1/articles.json?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Federal Register search failed (${res.status}) for "${keyword}"`);
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return results
    .filter(d => /airworthiness directive/i.test(d.title || ""))
    .map(d => ({
      source: "FAA",
      ref: d.document_number,
      url: d.html_url,
      issueDate: d.publication_date || "",
      subject: d.title || "",
      pdfUrl: d.pdf_url || "",
    }));
}

async function main() {
  const items = [];
  const seen = new Set();

  for (const kw of EASA_KEYWORDS) {
    try {
      const rows = await fetchEasaKeyword(kw);
      for (const r of rows) {
        const key = "EASA:" + r.ref;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...r, matchedKeyword: kw });
      }
      console.log(`EASA "${kw}": ${rows.length} row(s) fetched`);
    } catch (err) {
      console.error(`EASA "${kw}" failed:`, err.message);
    }
  }

  for (const kw of FAA_KEYWORDS) {
    try {
      const rows = await fetchFaaKeyword(kw);
      for (const r of rows) {
        const key = "FAA:" + r.ref;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...r, matchedKeyword: kw });
      }
      console.log(`FAA "${kw}": ${rows.length} row(s) fetched`);
    } catch (err) {
      console.error(`FAA "${kw}" failed:`, err.message);
    }
  }

  items.sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || ""));

  const out = {
    fetchedAt: new Date().toISOString(),
    keywords: { easa: EASA_KEYWORDS, faa: FAA_KEYWORDS },
    count: items.length,
    items,
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await fs.writeFile(new URL("../data/official-ads.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${items.length} item(s) to data/official-ads.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
