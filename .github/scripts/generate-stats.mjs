import fs from "node:fs";
import path from "node:path";

const owner = process.env.GITHUB_REPOSITORY_OWNER || "YRRLYB";
const outDir = process.argv[2] || "dist";
const token = process.env.GITHUB_TOKEN || "";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fetchStats() {
  if (process.env.GITHUB_STATS_JSON) {
    return JSON.parse(process.env.GITHUB_STATS_JSON);
  }
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to fetch GitHub stats");
  }

  let dispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    try {
      const undici = await import("undici");
      dispatcher = new undici.ProxyAgent(proxyUrl);
    } catch {
      dispatcher = undefined;
    }
  }

  const query = `
    query($login: String!) {
      user(login: $login) {
        followers { totalCount }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
          totalCount
          nodes {
            name
            stargazerCount
            languages(first: 6, orderBy: {field: SIZE, direction: DESC}) {
              edges {
                size
                node { name }
              }
            }
          }
        }
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays { contributionCount }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "yrrlyb-profile-stats",
    },
    body: JSON.stringify({ query, variables: { login: owner } }),
    ...(dispatcher ? { dispatcher } : {}),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL error ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  const user = payload.data.user;
  const repos = user.repositories.nodes;
  const totalStars = repos.reduce((sum, repo) => sum + repo.stargazerCount, 0);
  const topRepoNode = [...repos].sort((a, b) => b.stargazerCount - a.stargazerCount)[0] || { name: "Aria", stargazerCount: 0 };

  const langTotals = new Map();
  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      langTotals.set(edge.node.name, (langTotals.get(edge.node.name) || 0) + edge.size);
    }
  }
  const totalBytes = [...langTotals.values()].reduce((sum, size) => sum + size, 0) || 1;
  const langs = [...langTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, size]) => ({
      name,
      share: size / totalBytes,
      pct: ((size / totalBytes) * 100).toFixed(1),
    }));

  const weeks = user.contributionsCollection.contributionCalendar.weeks;
  const recent12Weeks = weeks
    .slice(-12)
    .map((week) => week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0));

  return {
    totalStars,
    publicRepos: user.repositories.totalCount,
    topRepoName: topRepoNode.name,
    topRepoStars: topRepoNode.stargazerCount,
    totalContributions: user.contributionsCollection.contributionCalendar.totalContributions,
    recent12Weeks,
    langs,
  };
}

function renderCard(mode, stats) {
  const isDark = mode === "dark";
  const bg = isDark ? "#0e0e0d" : "#f6f5f1";
  const border = isDark ? "#262522" : "#e2dfd7";
  const divider = isDark ? "#262522" : "#e2dfd7";
  const ink = isDark ? "#f2f0ea" : "#181715";
  const muted = isDark ? "#8d8a82" : "#706d66";
  const trackBg = isDark ? "#23221f" : "#e5e2d9";
  const accent = isDark ? "#a78bfa" : "#7c3aed";
  const segPalette = isDark
    ? [accent, "#6c6962", "#524f49", "#3c3a35", "#2d2b28"]
    : [accent, "#8b877e", "#ada99f", "#cac6bc", "#dedad0"];

  const weeks = stats.recent12Weeks.length === 12
    ? stats.recent12Weeks
    : [...Array(Math.max(0, 12 - stats.recent12Weeks.length)).fill(0), ...stats.recent12Weeks.slice(-12)];
  const maxWeek = Math.max(...weeks, 1);

  const sparkline = weeks
    .map((count, i) => {
      const h = count === 0 ? 3 : Math.max(4, Math.round((count / maxWeek) * 20));
      const x = 336 + i * 15;
      const y = 165 - h;
      const isPeak = count >= maxWeek * 0.65 && count > 0;
      const fill = isPeak ? accent : count === 0 ? trackBg : muted;
      const opacity = count === 0 ? "0.7" : isPeak ? "0.95" : "0.65";
      return `<rect x="${x}" y="${y}" width="9" height="${h}" rx="2" fill="${fill}" opacity="${opacity}"/>`;
    })
    .join("\n  ");

  const langs = stats.langs.length ? stats.langs : [{ name: "TypeScript", share: 1, pct: "100.0" }];
  const topLang = langs[0];
  const secondaryLangs = langs
    .slice(1, 4)
    .map((l) => (l.name === "JavaScript" ? "JS" : l.name))
    .join(" · ");

  const barWidth = 216;
  let cursor = 0;
  const langSegments = langs
    .map((lang, idx) => {
      const isLast = idx === langs.length - 1;
      const segW = isLast ? Math.max(0, barWidth - cursor) : Math.max(6, Math.round(lang.share * barWidth));
      const x = 636 + cursor;
      cursor += segW;
      return `<rect x="${x}" y="140" width="${segW}" height="5" fill="${segPalette[idx % segPalette.length]}"/>`;
    })
    .join("\n    ");

  const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="210" viewBox="0 0 1200 210" fill="none" role="img" aria-label="YRRLYB GitHub Stats">
  <defs>
    <clipPath id="lang-bar-clip-${mode}">
      <rect x="636" y="140" width="${barWidth}" height="5" rx="2.5"/>
    </clipPath>
  </defs>

  <rect x="0.5" y="0.5" width="1199" height="209" rx="19.5" fill="${bg}" stroke="${border}" stroke-width="1"/>

  <!-- Column 1: Stars -->
  <text x="56" y="68" fill="${muted}" font-family="${sans}" font-size="13" font-weight="500">获得星标 · Stars</text>
  <text x="56" y="124" fill="${ink}" font-family="${sans}" font-size="40" font-weight="600" letter-spacing="-0.5">${escapeXml(fmtNum(stats.totalStars))}</text>
  <text x="56" y="162" fill="${muted}" font-family="${mono}" font-size="12">公开仓库 ${escapeXml(stats.publicRepos)} · ${escapeXml(stats.topRepoName)} ${escapeXml(stats.topRepoStars)}</text>

  <line x1="300" y1="46" x2="300" y2="164" stroke="${divider}" stroke-width="1"/>

  <!-- Column 2: Contributions + 12-week Sparkline -->
  <text x="336" y="68" fill="${muted}" font-family="${sans}" font-size="13" font-weight="500">近一年贡献 · Contributions</text>
  <text x="336" y="124" fill="${ink}" font-family="${sans}" font-size="40" font-weight="600" letter-spacing="-0.5">${escapeXml(fmtNum(stats.totalContributions))}</text>
  ${sparkline}

  <line x1="600" y1="46" x2="600" y2="164" stroke="${divider}" stroke-width="1"/>

  <!-- Column 3: Primary Language + Proportion Bar -->
  <text x="636" y="68" fill="${muted}" font-family="${sans}" font-size="13" font-weight="500">主力语言 · Languages</text>
  <text x="636" y="120" fill="${ink}" font-family="${sans}" font-size="30" font-weight="600" letter-spacing="-0.5"><tspan>${escapeXml(topLang.name)}</tspan><tspan fill="${muted}" font-family="${mono}" font-size="14" font-weight="500" dx="10">${escapeXml(topLang.pct)}%</tspan></text>
  <rect x="636" y="140" width="${barWidth}" height="5" rx="2.5" fill="${trackBg}"/>
  <g clip-path="url(#lang-bar-clip-${mode})">
    ${langSegments}
  </g>
  <text x="636" y="162" fill="${muted}" font-family="${mono}" font-size="11.5">${escapeXml(secondaryLangs || topLang.name)}</text>

  <line x1="900" y1="46" x2="900" y2="164" stroke="${divider}" stroke-width="1"/>

  <!-- Column 4: ACG Gallery -->
  <text x="936" y="68" fill="${muted}" font-family="${sans}" font-size="13" font-weight="500">伊利布图库 · Gallery</text>
  <text x="936" y="124" fill="${ink}" font-family="${sans}" font-size="40" font-weight="600" letter-spacing="-0.5">18,000+</text>
  <text x="936" y="162" fill="${muted}" font-family="${mono}" font-size="12">二次元精选 · photo.yrrlyb.top</text>
</svg>
`;
}

const stats = await fetchStats();
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "stats-dark.svg"), renderCard("dark", stats), "utf8");
fs.writeFileSync(path.join(outDir, "stats-light.svg"), renderCard("light", stats), "utf8");
console.log("Generated stats-dark.svg & stats-light.svg in", outDir, stats);
