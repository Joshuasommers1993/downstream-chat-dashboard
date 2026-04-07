import { z } from "zod";
import { createTRPCRouter, protectedProjectProcedure } from "@/src/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { env } from "@/src/env.mjs";
import {
  getTracesByIds,
  upsertScore,
  convertDateToClickhouseDateTime,
} from "@langfuse/shared/src/server";
import { ScoreSourceEnum } from "@langfuse/shared";
import { v4 as uuidv4 } from "uuid";

const SCORE_PREFIX = "llm_judge";
const TIMEOUT_MS = 60_000;

const metrics = [
  {
    name: "correctness",
    prompt: (input: unknown, output: unknown) =>
      `You are evaluating an AI assistant for Downstream, a B2B marketplace platform.

The assistant helps users find suppliers, manage orders, track invoices, and navigate the platform.

USER INPUT:
${JSON.stringify(input, null, 2)}

ASSISTANT OUTPUT:
${JSON.stringify(output, null, 2)}

Evaluate CORRECTNESS: Did the assistant provide accurate, factually correct information?
Consider:
- Are facts, numbers, and data points accurate?
- Did it correctly use tool/API results?
- Did it avoid hallucinating information?

Score 1-5:
1 = Completely wrong or fabricated
2 = Mostly wrong with some correct parts
3 = Partially correct, some errors
4 = Mostly correct, minor issues
5 = Completely accurate

Respond ONLY in JSON: {"score": <1-5>, "reasoning": "<one sentence>"}`,
  },
  {
    name: "relevance",
    prompt: (input: unknown, output: unknown) =>
      `You are evaluating an AI assistant for Downstream, a B2B marketplace platform.

USER INPUT:
${JSON.stringify(input, null, 2)}

ASSISTANT OUTPUT:
${JSON.stringify(output, null, 2)}

Evaluate RELEVANCE: Did the assistant directly address what the user asked?
Consider:
- Did it answer the actual question?
- Did it stay on topic?
- Did it avoid unnecessary tangents?

Score 1-5:
1 = Completely off-topic
2 = Mostly irrelevant
3 = Partially relevant
4 = Mostly relevant, minor digressions
5 = Perfectly on-topic

Respond ONLY in JSON: {"score": <1-5>, "reasoning": "<one sentence>"}`,
  },
  {
    name: "tool_use",
    prompt: (input: unknown, output: unknown) =>
      `You are evaluating an AI assistant for Downstream, a B2B marketplace platform.

The assistant has access to API tools for: users, orders, invoices, suppliers, products, payments.

USER INPUT:
${JSON.stringify(input, null, 2)}

ASSISTANT OUTPUT:
${JSON.stringify(output, null, 2)}

Evaluate TOOL USE: Did the assistant use appropriate tools to answer the query?
Consider:
- Did it fetch real data rather than guessing?
- Did it use the most relevant API endpoints?
- Did it handle tool results correctly?
- If no tools were needed, did it avoid unnecessary calls?

Score 1-5:
1 = Used wrong tools or made up data instead of using tools
2 = Used tools but ineffectively
3 = Used tools adequately
4 = Good tool use with minor inefficiencies
5 = Optimal tool use

Respond ONLY in JSON: {"score": <1-5>, "reasoning": "<one sentence>"}`,
  },
];

function parseJudgeResponse(text: string): { score: number; reasoning: string } {
  const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*"score"[\s\S]*"reasoning"[\s\S]*\}/);
  if (!match) throw new Error(`Could not parse judge response: ${text}`);
  const parsed = JSON.parse(match[0]) as { score: unknown; reasoning: unknown };
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new Error(`Invalid score value: ${String(parsed.score)}`);
  }
  return { score, reasoning: String(parsed.reasoning ?? "") };
}

async function callJudge(prompt: string, apiUrl: string, apiKey: string, agentId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: agentId,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Judge API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from judge");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export const evaluationRouter = createTRPCRouter({
  runOnTraces: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceIds: z.array(z.string()).min(1).max(50),
      }),
    )
    .mutation(async ({ input }) => {
      const apiUrl = env.LIBRECHAT_JUDGE_API_URL;
      const apiKey = env.LIBRECHAT_JUDGE_API_KEY;
      const agentId = env.LIBRECHAT_JUDGE_AGENT_ID;

      if (!apiUrl || !apiKey || !agentId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "LLM judge is not configured. Set LIBRECHAT_JUDGE_API_URL, LIBRECHAT_JUDGE_API_KEY, and LIBRECHAT_JUDGE_AGENT_ID.",
        });
      }

      const traces = await getTracesByIds(input.traceIds, input.projectId);

      let scored = 0;
      let skipped = 0;
      const errors: string[] = [];

      await Promise.all(
        traces.map(async (trace) => {
          if (!trace.input && !trace.output) {
            skipped++;
            return;
          }

          await Promise.all(
            metrics.map(async (metric) => {
              try {
                const prompt = metric.prompt(trace.input, trace.output);
                const raw = await callJudge(prompt, apiUrl, apiKey, agentId);
                const { score, reasoning } = parseJudgeResponse(raw);
                const now = new Date();
                await upsertScore({
                  id: uuidv4(),
                  timestamp: convertDateToClickhouseDateTime(now),
                  project_id: input.projectId,
                  environment: "default",
                  trace_id: trace.id,
                  observation_id: null,
                  session_id: trace.sessionId ?? null,
                  name: `${SCORE_PREFIX}_${metric.name}`,
                  value: score,
                  source: ScoreSourceEnum.API,
                  comment: reasoning,
                  metadata: {},
                  author_user_id: null,
                  config_id: null,
                  data_type: "NUMERIC",
                  string_value: null,
                  long_string_value: "",
                  queue_id: null,
                  execution_trace_id: null,
                  is_deleted: 0,
                  created_at: convertDateToClickhouseDateTime(now),
                  updated_at: convertDateToClickhouseDateTime(now),
                  event_ts: convertDateToClickhouseDateTime(now),
                });
              } catch (e) {
                errors.push(`${trace.id}/${metric.name}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }),
          );

          scored++;
        }),
      );

      return { scored, skipped, errors };
    }),
});
