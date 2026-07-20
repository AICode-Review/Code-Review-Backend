#!/usr/bin/env node
import { Command } from "commander";
import { createCliRouter } from "./llmRouter.js";
import { assembleLocalContext, findGitRoot } from "./localDiff.js";
import { runLocalReview } from "./review.js";
import { format, type OutputFormat } from "./formatters.js";
import { writeReviewConfig } from "./configInit.js";

const program = new Command();
program.name("codeferret").description("Local + CI code review using the same multi-pass + verification engine as the CodeFerret PR bot.");

program
  .command("review")
  .description("Review the diff between the current branch and a base ref. Prints nothing to any PR — terminal or a file only.")
  .option("--base <ref>", "base ref to diff against", "main")
  .option("--format <format>", "text | json | github", "text")
  .option("--cost-cap <usd>", "stop starting new passes once spend reaches this", "0.60")
  .action(async (opts: { base: string; format: string; costCap: string }) => {
    const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
    const openaiApiKey = process.env["OPENAI_API_KEY"];
    if (!anthropicApiKey || !openaiApiKey) {
      console.error("ANTHROPIC_API_KEY and OPENAI_API_KEY must both be set — the same two keys the CodeFerret backend uses.");
      process.exitCode = 1;
      return;
    }
    if (!["text", "json", "github"].includes(opts.format)) {
      console.error(`Unknown --format "${opts.format}" — expected text, json, or github.`);
      process.exitCode = 1;
      return;
    }

    const repoRoot = findGitRoot(process.cwd());
    const local = await assembleLocalContext(repoRoot, opts.base);
    if (local.files.length === 0) {
      console.log(`No reviewable file changes between ${opts.base} and HEAD.`);
      return;
    }

    const router = createCliRouter({
      anthropicApiKey,
      openaiApiKey,
      frontierModel: process.env["CODEFERRET_MODEL_FRONTIER"] ?? "claude-sonnet-5",
      midModel: process.env["CODEFERRET_MODEL_MID"] ?? "claude-haiku-4-5",
      skepticModel: process.env["CODEFERRET_MODEL_SKEPTIC"] ?? "gpt-5",
    });

    const findings = await runLocalReview(router, local, { costCapUsd: Number(opts.costCap) });
    console.log(format(findings, opts.format as OutputFormat));
    if (findings.some((f) => f.severity === "critical")) process.exitCode = 1;
  });

const config = program.command("config").description("Manage .review.yml");
config
  .command("init")
  .description("Write a starter .review.yml into the repo root")
  .option("--force", "overwrite an existing .review.yml", false)
  .action(async (opts: { force: boolean }) => {
    const repoRoot = findGitRoot(process.cwd());
    const { path, wrote } = await writeReviewConfig(repoRoot, opts.force);
    console.log(wrote ? `Wrote ${path}` : `${path} already exists — use --force to overwrite.`);
  });

const auth = program.command("auth").description("Link the CLI to your CodeFerret org");
auth
  .command("login")
  .description("Not implemented yet — see notes below")
  .action(() => {
    console.log(
      [
        "`codeferret auth login` isn't implemented yet: it needs an org-scoped API-key",
        "system on the backend (issue/verify/revoke a key, distinct from the web app's",
        "Supabase session auth) that doesn't exist today. `codeferret review` doesn't need",
        "it — it talks directly to Anthropic/OpenAI with your own API keys and never",
        "touches your CodeFerret account. Rulebook/analytics sync via the CLI is blocked on",
        "that backend feature landing first.",
      ].join("\n"),
    );
    process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
