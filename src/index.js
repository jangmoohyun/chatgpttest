import "dotenv/config";
import express from "express";
import cors from "cors";
import { Client } from "@notionhq/client";

const app = express();
app.use(cors());

// ✅ 응답 UTF-8
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// ✅ JSON을 raw(Buffer)로 받고 UTF-8로 파싱 (Windows 한글 깨짐 완화)
app.use(
  express.raw({
    type: (req) => (req.headers["content-type"] || "").includes("application/json"),
    limit: "2mb",
  })
);

app.use((req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json") && Buffer.isBuffer(req.body)) {
    try {
      req.bodyJson = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }
  }
  next();
});

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ✅ API Key 인증
app.use((req, res, next) => {
  const key = req.header("x-api-key");
  if (!process.env.API_KEY) return res.status(500).json({ ok: false, error: "API_KEY not set" });
  if (key !== process.env.API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

function plain(rt = []) {
  return rt.map((x) => x.plain_text ?? "").join("");
}

async function listChildren(blockId) {
  const out = [];
  let cursor = undefined;
  while (true) {
    const r = await notion.blocks.children.list({
      block_id: String(blockId),
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor ?? undefined;
  }
  return out;
}

function titleOfPage(p) {
  const props = p.properties || {};
  const titleKey = Object.keys(props).find((k) => props[k]?.type === "title");
  return titleKey ? plain(props[titleKey]?.title) : "";
}

async function findPagesByTitle(title) {
  const r = await notion.search({
    query: title,
    filter: { property: "object", value: "page" },
    page_size: 10,
  });

  return r.results
    .map((p) => ({ id: p.id, url: p.url, title: titleOfPage(p) }))
    .filter((x) => x.title);
}

function pickCandidate(title, candidates) {
  const exact = candidates.find((c) => c.title === title);
  if (exact) return { picked: exact, exact: true };
  if (candidates.length === 1) return { picked: candidates[0], exact: false };
  return { picked: null, exact: false };
}

async function appendTextToPage(pageId, content) {
  const lines = String(content)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const children = lines.map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
  }));

  await notion.blocks.children.append({ block_id: pageId, children });
  return children.length;
}

async function clearPageTopLevelBlocks(pageId) {
  // ✅ top-level 블록만 archived 처리하면 내부(children)도 같이 사라지는 효과
  const top = await listChildren(pageId);

  // 너무 많을 때 429 방지용 약간의 템포
  let i = 0;
  for (const b of top) {
    await notion.blocks.update({ block_id: b.id, archived: true });
    i += 1;
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 150));
  }
  return top.length;
}

/** 0) find_page : title -> 후보 리스트 */
app.get("/find_page", async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) return res.status(400).json({ ok: false, error: "title required" });

    const results = await findPagesByTitle(String(title));
    res.json({ ok: true, query: title, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 1) read_page : 재귀로 텍스트 수집 (컬럼/토글 포함) */
app.get("/read_page", async (req, res) => {
  try {
    const { page_id } = req.query;
    if (!page_id) return res.status(400).json({ ok: false, error: "page_id required" });

    const lines = [];

    async function walk(block, depth = 0) {
      const type = block.type;
      const data = block[type];

      let t = "";
      if (type === "paragraph") t = plain(data?.rich_text);
      else if (type === "heading_1") t = "# " + plain(data?.rich_text);
      else if (type === "heading_2") t = "## " + plain(data?.rich_text);
      else if (type === "heading_3") t = "### " + plain(data?.rich_text);
      else if (type === "bulleted_list_item") t = "- " + plain(data?.rich_text);
      else if (type === "numbered_list_item") t = "1. " + plain(data?.rich_text);
      else if (type === "to_do") t = (data?.checked ? "[x] " : "[ ] ") + plain(data?.rich_text);
      else if (type === "quote") t = "> " + plain(data?.rich_text);
      else if (type === "callout") t = "💬 " + plain(data?.rich_text);

      if (t && t.trim()) lines.push(`${"  ".repeat(depth)}${t.trim()}`);

      if (block.has_children) {
        const children = await listChildren(block.id);
        for (const c of children) await walk(c, depth + 1);
      }
    }

    const top = await listChildren(String(page_id));
    for (const b of top) await walk(b, 0);

    res.json({ ok: true, text: lines.join("\n") });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 2) update_page : page_id로 append */
app.post("/update_page", async (req, res) => {
  try {
    const { page_id, content } = req.bodyJson ?? {};
    if (!page_id || typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "page_id and content required" });
    }

    const appended = await appendTextToPage(page_id, content);
    res.json({ ok: true, appended });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 3) create_page : parent 아래 새 페이지 생성 */
app.post("/create_page", async (req, res) => {
  try {
    const { parent_page_id, title, content } = req.bodyJson ?? {};
    if (!parent_page_id || !title || typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "parent_page_id, title, content required" });
    }

    const lines = String(content)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const children = lines.map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
    }));

    const created = await notion.pages.create({
      parent: { type: "page_id", page_id: parent_page_id },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
      },
      children,
    });

    res.json({ ok: true, page_id: created.id, url: created.url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 4) append_by_title : 제목으로 찾아서 append (page_id 숨김) */
app.post("/append_by_title", async (req, res) => {
  try {
    const { title, content } = req.bodyJson ?? {};
    if (!title || typeof title !== "string" || typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "title and content required" });
    }

    const candidates = await findPagesByTitle(title);
    const { picked, exact } = pickCandidate(title, candidates);

    if (!picked) {
      return res.json({
        ok: false,
        error: "Multiple matches. Please specify the exact page title.",
        candidates,
      });
    }

    const appended = await appendTextToPage(picked.id, content);

    res.json({
      ok: true,
      appended,
      page_id: picked.id,
      page_title: picked.title,
      page_url: picked.url,
      warning: !exact && candidates.length > 1 ? "Not exact match, first candidate selected." : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** 5) replace_by_title : 제목으로 찾아서 (기존 내용 삭제) 후 새로 append */
app.post("/replace_by_title", async (req, res) => {
  try {
    const { title, content, confirm } = req.bodyJson ?? {};
    if (!title || typeof title !== "string" || typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "title and content required" });
    }

    // ✅ 안전장치: replace는 confirm=true 필요 (GPT가 자동으로 넣게 하면 UX 유지됨)
    if (confirm !== true) {
      return res.status(400).json({
        ok: false,
        error: "This will clear existing content. Set confirm=true to proceed.",
      });
    }

    const candidates = await findPagesByTitle(title);
    const { picked, exact } = pickCandidate(title, candidates);

    // replace는 더 보수적으로: 완전일치가 없고 후보가 여러개면 멈춤
    if (!picked || (!exact && candidates.length > 1)) {
      return res.json({
        ok: false,
        error: "Multiple matches. Please specify the exact page title before replacing.",
        candidates,
      });
    }

    const cleared = await clearPageTopLevelBlocks(picked.id);
    const appended = await appendTextToPage(picked.id, content);

    res.json({
      ok: true,
      cleared_blocks: cleared,
      appended,
      page_id: picked.id,
      page_title: picked.title,
      page_url: picked.url,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`✅ notion-write-api listening on :${port}`));
