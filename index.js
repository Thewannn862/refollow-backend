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
  console.error("Missing NEYNAR_API_KEY in .env");
  process.exit(1);
}

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(cookieParser());

app.get("/", (req, res) => {
  res.send("Refollow backend is running");
});

const CACHE_TTL_MS = 5 * 60 * 1000;
const refollowCache = new Map();

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

// akun creator yang wajib di-follow
const CREATOR_USERNAMES = ["sir-wannn", "tompenoz"];
let CREATOR_FIDS = [];

// resolve FID creator sekali di awal
async function resolveCreatorFids() {
  try {
    const resultFids = [];
    for (const username of CREATOR_USERNAMES) {
      const data = await neynarFetch(
        `/v2/farcaster/user/by_username?username=${encodeURIComponent(
          username
        )}`
      );
      const user = data.user || data.result?.user;
      if (user && typeof user.fid === "number") {
        resultFids.push(user.fid);
      }
    }
    CREATOR_FIDS = resultFids;
    console.log("Creator FIDs:", CREATOR_FIDS);
  } catch (e) {
    console.error("Failed to resolve creator fids", e);
    // kalau gagal resolve, jangan kunci semua orang
    CREATOR_FIDS = [];
  }
}

resolveCreatorFids();

// TIDAK pakai Quick Auth: fid dikirim dari frontend via query ?fid=
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

    if (!forceRefresh && cookieTs && hasFreshCache) {
      return res.json(cacheEntry.data);
    }

    // 1) akun yang user follow
    const linksByFid = await neynarFetch(
      `/v1/linksByFid?fid=${fid}&link_type=follow`
    );

    const followingFids = new Set();
    for (const msg of linksByFid.messages || []) {
      const targetFid = msg?.data?.linkBody?.targetFid;
      if (typeof targetFid === "number") followingFids.add(targetFid);
    }

    // cek: user harus follow KEDUA creator
    if (CREATOR_FIDS.length > 0) {
      const followsBoth =
        CREATOR_FIDS.length > 0 &&
        CREATOR_FIDS.every((c) => followingFids.has(c));

      if (!followsBoth) {
        return res.status(403).json({
          error:
            "To use Refollow, please follow both @sir-wannn and @tompenoz on Farcaster, then try again.",
        });
      }
    }

    // 2) akun yang follow user
    const linksByTarget = await neynarFetch(
      `/v1/linksByTargetFid?target_fid=${fid}&link_type=follow`
    );

    const followersFids = new Set();
    for (const msg of linksByTarget.messages || []) {
      const sourceFid = msg?.data?.fid;
      if (typeof sourceFid === "number") followersFids.add(sourceFid);
    }

    // 3) not following back
    const notFollowingBackFids = new Set();
    for (const f of followingFids) {
      if (!followersFids.has(f)) notFollowingBackFids.add(f);
    }

    // 4) kumpulin semua FID untuk user/bulk
    const allFids = Array.from(
      new Set([...followingFids, ...followersFids, ...notFollowingBackFids])
    );

    const usersByFid = new Map();

    if (allFids.length > 0) {
      const bulk = await neynarFetch(
        `/v2/farcaster/user/bulk?fids=${allFids.join(",")}`
      );
      const users = Array.isArray(bulk.users) ? bulk.users : [];
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

    refollowCache.set(fid, { data, updatedAt: now });

    res.cookie("refollow_cache_ts", String(now), {
      maxAge: CACHE_TTL_MS,
      sameSite: "none",
      secure: process.env.NODE_ENV === "production",
    });

    res.json(data);
  } catch (e) {
    console.error("refollow error", e);
    res.status(500).json({ error: "Failed to build refollow data" });
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("refollow_cache_ts");
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Refollow backend listening on ${port}`);
});
