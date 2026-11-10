import { execFile } from "node:child_process";

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

/** Last N commits via execFile (no shell). Returns [] if git is unavailable. */
export function recentCommits(repoRoot: string, n = 15): Promise<CommitInfo[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoRoot, "log", "--format=%H%x09%an%x09%aI%x09%s", "-n", String(n)],
      { encoding: "utf8", timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const [sha = "", author = "", date = "", ...rest] = l.split("\t");
              return { sha, author, date, subject: rest.join("\t") };
            }),
        );
      },
    );
  });
}
