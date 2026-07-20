import { env, githubPrivateKey } from "../config.js";
import type { Platform } from "../types/domain.js";
import type { PlatformAdapter } from "./types.js";
import { GithubAdapter } from "./github/adapter.js";
import { BitbucketAdapter } from "./bitbucket/adapter.js";

let github: GithubAdapter | undefined;
let bitbucket: BitbucketAdapter | undefined;

export function getAdapter(platform: Platform): PlatformAdapter {
  if (platform === "github") {
    github ??= new GithubAdapter({
      appId: env().GITHUB_APP_ID,
      privateKey: githubPrivateKey(),
      webhookSecret: env().GITHUB_WEBHOOK_SECRET,
    });
    return github;
  }
  const webhookSecret = env().BITBUCKET_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("Bitbucket PR review is not configured on this deployment — set BITBUCKET_WEBHOOK_SECRET (sign-in via Bitbucket OAuth works independently of this).");
  }
  bitbucket ??= new BitbucketAdapter({ webhookSecret });
  return bitbucket;
}
