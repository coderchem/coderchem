// Refreshes the "活跃" and "Pull Request" blocks of README.md.
// Runs inside actions/github-script, which provides `github`, `context` and `core`.
const README_PATH = "README.md";
const MAX_PRS = 10;
const MAX_TITLE_LENGTH = 80;
const ACTIVITY_WINDOW_DAYS = 30;
const STREAK_WINDOW_DAYS = 365;

const BLOCKS = {
  activity: ["<!-- ACTIVITY:START -->", "<!-- ACTIVITY:END -->"],
  prs: ["<!-- PR_LIST:START -->", "<!-- PR_LIST:END -->"],
};

const CONTRIBUTIONS_QUERY = `query($login: String!, $windowStart: DateTime!, $yearStart: DateTime!, $now: DateTime!) {
  user(login: $login) {
    recent: contributionsCollection(from: $windowStart, to: $now) {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
    }
    year: contributionsCollection(from: $yearStart, to: $now) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "&#124;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shorten(title) {
  const characters = Array.from(title);
  return characters.length > MAX_TITLE_LENGTH
    ? `${characters.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`
    : title;
}

function currentStreak(days) {
  let index = days.length - 1;
  // Today, and the empty days GitHub pre-fills at the end of the calendar, must not break the streak.
  while (index >= 0 && days[index].contributionCount === 0) index -= 1;
  let streak = 0;
  while (index >= 0 && days[index].contributionCount > 0) {
    streak += 1;
    index -= 1;
  }
  return streak;
}

function prState(item) {
  if (item.pull_request?.merged_at) return "🟣 Merged";
  if (item.state === "closed") return "🔴 Closed";
  return item.draft ? "🚧 Draft" : "🟢 Open";
}

function renderActivity(user, streak) {
  const { recent, year } = user;
  return [
    "**近 30 天**",
    "",
    `- 🔨 提交：**${recent.totalCommitContributions}**`,
    `- 🔀 Pull Request：**${recent.totalPullRequestContributions}**`,
    `- 👀 PR 评审：**${recent.totalPullRequestReviewContributions}**`,
    `- 📝 Issue：**${recent.totalIssueContributions}**`,
    "",
    `🔥 连续贡献 **${streak}** 天 · 近一年 **${year.contributionCalendar?.totalContributions ?? 0}** 次`,
  ].join("\n");
}

function renderPrList(items, login) {
  if (items.length === 0) return "还没有公开的 Pull Request。";
  const rows = items.map((item) => {
    const match = item.html_url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/);
    const repository = match ? `${match[1]}/${match[2]} #${item.number}` : "";
    const title = `<a href="${escapeHtml(item.html_url)}">${escapeHtml(shorten(item.title))}</a>`;
    const firstCell = repository ? `${title}<br><sub>${escapeHtml(repository)}</sub>` : title;
    return `| ${firstCell} | ${prState(item)} | ${item.created_at.slice(0, 10)} |`;
  });
  return [
    "| Pull Request | 状态 | 创建于 |",
    "| :--- | :---: | ---: |",
    ...rows,
    "",
    `[查看全部 →](https://github.com/pulls?q=is%3Apr+author%3A${login})`,
  ].join("\n");
}

function replaceBlock(readme, [start, end], body) {
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(readme)) {
    throw new Error(`README.md is missing the "${start} … ${end}" block, nothing was changed.`);
  }
  return readme.replace(pattern, () => `${start}\n${body}\n${end}`);
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;

  const { data } = await github.graphql(CONTRIBUTIONS_QUERY, {
    login: owner,
    windowStart: daysAgo(ACTIVITY_WINDOW_DAYS),
    yearStart: daysAgo(STREAK_WINDOW_DAYS),
    now: new Date().toISOString(),
  });
  if (!data.user?.recent || !data.user?.year) {
    throw new Error(`Could not read contributions for @${owner}, nothing was changed.`);
  }

  const { data: search } = await github.rest.search.issuesAndPullRequests({
    q: `is:pr author:${owner}`,
    sort: "created",
    order: "desc",
    per_page: MAX_PRS,
  });

  const { data: file } = await github.rest.repos.getContent({ owner, repo, path: README_PATH });
  const readme = Buffer.from(file.content, "base64").toString("utf8");

  const days = data.user.year.contributionCalendar?.weeks.flatMap((week) => week.contributionDays) ?? [];
  const updated = replaceBlock(
    replaceBlock(readme, BLOCKS.activity, renderActivity(data.user, currentStreak(days))),
    BLOCKS.prs,
    renderPrList(search.items, owner),
  );

  if (updated === readme) {
    core.info("README.md is already up to date.");
    return;
  }

  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: README_PATH,
    message: "chore: refresh activity and pull request list",
    content: Buffer.from(updated, "utf8").toString("base64"),
    sha: file.sha,
  });
  core.info("README.md updated.");
};
