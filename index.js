import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = process.env.PORT || 8787;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;

if (!NEYNAR_API_KEY) {
  console.error("Missing NEYNAR_API_KEY in .env / environment");
  process.exit(1);
}

app.use(
  cors({
    origin: true,       // miniapp host mana pun
    credentials: true,  // biar cookie ke-set
  })
);
app.use(cookieParser());

app.get("/", (req, res) => {
  res.send("Refollow backend is running");
});

// cache sederhana di memory
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit
const refollowCache = new Map();    // key: fid -> { data, updatedAt }

// helper umum ke Neynar
async function neynarFetch(path) {
  const url = `https://api.neynar.com${path}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": NEYNAR_API_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Neynar error response:", text);
    throw new Error(`Neynar error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Ambil list FID untuk:
 *  kind === "followers" -> orang yang follow kita
 *  kind === "following" -> orang yang kita follow
 *
 * Pakai API baru Neynar:
 *  - GET /v2/farcaster/followers/
 *  - GET /v2/farcaster/following/
 *
 * Biar hemat kredit + simple, kita batasi max 3 page x 100 = 300 akun per sisi.
 */
async function fetchFollowFids(kind, fid) {
  const fids = new Set();
  let cursor = undefined;
  const MAX_PAGES = 3;
  let page = 0;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams();
    params.set("fid", String(fid));
    params.set("limit", "100");
    if (cursor) params.set("cursor", cursor);

    // contoh path: /v2/farcaster/followers/?fid=...&limit=100
    const json = await neynarFetch(
      `/v2/farcaster/${kind}/?${params.toString()}`
    );

    const users = json.users || json.result?.users || [];
    for (const u of users) {
      if (u && typeof u.fid === "number") {
        fids.add(u.fid);
      }
    }

    const nextObj = json.next || json.result?.next;
    const nextCursor = nextObj && (nextObj.cursor || nextObj);

    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
    page += 1;
  }

  return fids;
}

// endpoint utama yang dipanggil miniapp
// /refollow?fid=473291
app.get("/refollow", async (req, res) => {
  try {
    const fid = String(req.query.fid || "").trim();
    if (!fid) {
      return res.status(400).json({ error: "Missing fid" });
    }

    const now = Date.now();
    const cookieTs = Number(req.cookies["refollow_cache_ts"] || 0);
    const cacheEntry = refollowCache.get(fid);
    const hasFreshCache =
      cacheEntry && now - cacheEntry.updatedAt < CACHE_TTL_MS;

    const forceRefresh = req.query.refresh === "true";

    // kalau ada cache dan nggak di-force refresh -> pakai cache
    if (!forceRefresh && cookieTs && hasFreshCache) {
      return res.json(cacheEntry.data);
    }

    // 1) orang yang KAMU FOLLOW
    const followingFids = await fetchFollowFids("following", fid);

    // 2) orang yang FOLLOW KAMU
    const followersFids = await fetchFollowFids("followers", fid);

    // 3) not-following-back = yang kamu follow, tapi dia nggak follow balik
    const notFollowingBackFids = new Set();
    for (const f of followingFids) {
      if (!followersFids.has(f)) {
        notFollowingBackFids.add(f);
      }
    }

    // 4) gabung semua FID buat di-hydrate lewat /user/bulk
    const allFids = Array.from(
      new Set([...followingFids, ...followersFids, ...notFollowingBackFids])
    );

    const usersByFid = new Map();

    if (allFids.length > 0) {
      const bulk = await neynarFetch(
        `/v2/farcaster/user/bulk?fids=${allFids.join(",")}`
      );

      const users = Array.isArray(bulk.users)
        ? bulk.users
        : bulk.result?.users || [];

      for (const u of users) {
        if (u && typeof u.fid === "number") {
          usersByFid.set(u.fid, u);
        }
      }
    }

    function buildList(fidSet) {
      return Array.from(fidSet).map((id) => {
        const u = usersByFid.get(id) || { fid: id };
        return {
          fid: id,
          username: u.username,
          displayName: u.display_name || u.displayName,
          pfpUrl: u.pfp_url || u.pfpUrl,
        };
      });
    }

    const data = {
      following: buildList(followingFids),
      followers: buildList(followersFids),
      notFollowingBack: buildList(notFollowingBackFids),
    };

    // simpan cache
    refollowCache.set(fid, { data, updatedAt: now });

    // set cookie buat throttle
    res.cookie("refollow_cache_ts", String(now), {
      maxAge: CACHE_TTL_MS,
      sameSite: "none",
      secure: true,
    });

    res.json(data);
  } catch (e) {
    console.error("refollow error", e);
    res.status(500).json({ error: "Failed to build refollow data" });
  }
});

// buat tombol Disconnect di miniapp
app.post("/logout", (req, res) => {
  res.clearCookie("refollow_cache_ts");
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Refollow backend listening on ${port}`);
});
