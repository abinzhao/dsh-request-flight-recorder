import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import RequestFlightRecorder from '../src/index.js'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

describe('supported DeepSeek Harness compatibility', () => {
  it('captures two official Agent Loop requests through the local Mock LLM', async () => {
    const apiKey = 'compatibility-mock-key'
    const server = await startMockLlmServer({
      sequence: ['success', 'success'],
      apiKey,
      successText: 'compatibility response',
    })
    vi.stubEnv('DEEPSEEK_API_KEY', apiKey)
    const ctx = new Context()
    contexts.push(ctx)

    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        persona: '',
      })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LlmDeepSeek, {
        baseURL: server.baseURL,
        thinking: 'disabled',
        models: [{
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          contextWindow: 64_000,
          maxTokens: 8_192,
        }],
      })
      await ctx.plugin(CommandRuntime)
      await ctx.plugin(RequestFlightRecorder, { capacity: 8 })

      const handle = await ctx.agents.create({
        sessionId: SessionId('compatibility'),
        agentOptions: {
          provider: 'deepseek-official',
          model: 'deepseek-chat',
        },
      })
      const { agent } = handle
      await send(agent, 'compatibility prompt canary one')
      await send(agent, 'compatibility prompt canary two')

      expect(server.requests).toHaveLength(2)
      const snapshot = ctx.requestFlightRecorder.snapshot({
        sessionId: agent.session.id,
      })
      expect(snapshot.records).toHaveLength(2)
      expect(snapshot.health).toMatchObject({
        captured: 2,
        completed: 2,
        active: 0,
        correlationMisses: 0,
        projectionFailures: 0,
      })

      const prefix = snapshot.records[0]!.id.slice(0, 8)
      const results = []
      for (const line of [
        '/flight',
        '/flight list',
        `/flight show ${prefix}`,
        '/flight diff',
        '/flight health',
      ]) {
        const execution = await ctx.commands.execute(
          agent,
          line,
          new AbortController().signal,
        )
        expect(execution?.result.kind).toBe('success')
        results.push(execution?.result)
      }

      const diagnostics = JSON.stringify({ snapshot, results })
      expect(diagnostics).not.toContain('compatibility prompt canary')
      expect(diagnostics).not.toContain('compatibility response')
      expect(diagnostics).not.toContain(apiKey)

      const recorder = ctx.requestFlightRecorder
      await handle.dispose()
      await ctx.fiber.dispose()
      expect(recorder.snapshot()).toMatchObject({
        revision: 0,
        records: [],
        health: {
          captured: 0,
          completed: 0,
          retained: 0,
          active: 0,
        },
      })
    } finally {
      await server.close()
    }
  }, 30_000)
})
