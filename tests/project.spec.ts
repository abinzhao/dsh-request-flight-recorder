import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message, MessageId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { projectPromptAssembly, projectRequest } from '../src/project.js'

const SECRET = 'TOP_SECRET_VALUE'
const ZERO_OMISSIONS = {
  requestTools: 0,
  promptTools: 0,
  promptSections: 0,
  promptContexts: 0,
  promptVariables: 0,
  messageRoles: 0,
  messageSources: 0,
  messageBlockTypes: 0,
  oversizedNames: 0,
  truncatedToolSchemas: 0,
} as const

function message(
  id: string,
  role: Message['role'],
  source: Message['source'],
  content: Message['content'],
): Message {
  return {
    id: id as MessageId,
    role,
    source,
    content,
  }
}

function tool(): ToolSchema {
  return {
    name: 'read_file',
    description: `description-${SECRET}`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `parameter-${SECRET}`,
        },
      },
      required: ['path'],
    },
  }
}

function request(): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [
      message('system', 'system', { kind: 'plugin', plugin: 'persona' }, [
        { type: 'text', text: `system-${SECRET}` },
      ]),
      message('user', 'user', { kind: 'user' }, [
        { type: 'text', text: `user-${SECRET}` },
      ]),
      message(
        'assistant',
        'assistant',
        { kind: 'plugin', plugin: 'recall', form: 'recall' },
        [
          { type: 'reasoning', text: `reasoning-${SECRET}` },
          {
            type: 'tool-call',
            id: 'call-1' as never,
            name: 'read_file',
            arguments: JSON.stringify({ path: SECRET }),
          },
        ],
      ),
    ],
    system: `prompt-${SECRET}`,
    tools: [tool()],
    reasoningEffort: 'high' as never,
    temperature: 0.25,
    maxTokens: 4096,
    stop: ['done', SECRET],
  }
}

describe('projectRequest', () => {
  it('preserves request structure without retaining model-visible content', () => {
    const projection = projectRequest(request())

    expect(projection.summary).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      temperature: 0.25,
      maxTokens: 4096,
      stopCount: 2,
      messages: {
        total: 3,
        byRole: {
          assistant: 1,
          system: 1,
          user: 1,
        },
        bySource: {
          'plugin:opaque': 1,
          'plugin:recall': 1,
          user: 1,
        },
        byBlockType: {
          reasoning: 1,
          text: 2,
          'tool-call': 1,
        },
      },
      systemCharacters: 23,
      tools: [{
        name: 'read_file',
        parameterNodes: 8,
      }],
    })
    expect(projection.omissions).toEqual(ZERO_OMISSIONS)
    expect(JSON.stringify(projection)).not.toContain(SECRET)
  })

  it('omits optional request fields that are absent', () => {
    const projection = projectRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
    })

    expect(projection.summary).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: {
        total: 0,
        byRole: {},
        bySource: {},
        byBlockType: {},
      },
      systemCharacters: 0,
      tools: [],
    })
    expect(projection.omissions).toEqual(ZERO_OMISSIONS)
  })

  it('bounds request tools and reports the omitted count', () => {
    const tools = Array.from({ length: 129 }, (_, index) => ({
      ...tool(),
      name: `tool_${index}`,
    }))

    const projection = projectRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      tools,
    }) as unknown as {
      readonly summary: {
        readonly tools: readonly { readonly name: string }[]
      }
      readonly omissions: {
        readonly requestTools: number
      }
    }

    expect(projection.summary.tools).toHaveLength(128)
    expect(projection.summary.tools.at(0)?.name).toBe('tool_0')
    expect(projection.summary.tools.at(-1)?.name).toBe('tool_127')
    expect(projection.omissions.requestTools).toBe(1)
  })

  it('stops cyclic tool schema traversal and reports truncation', () => {
    const parameters: Record<string, unknown> = {
      type: 'object',
    }
    parameters.self = parameters

    const projection = projectRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      tools: [{
        name: 'cyclic_tool',
        description: 'TOP_SECRET_VALUE',
        parameters: parameters as unknown as ToolSchema['parameters'],
      }],
    })

    expect(projection.summary.tools).toEqual([{
      name: 'cyclic_tool',
      parameterNodes: 2,
    }])
    expect(projection.omissions.truncatedToolSchemas).toBe(1)
  })

  it('caps large tool schemas at the exported node limit', () => {
    const parameters = Array.from({ length: 4097 }, () => null)

    const projection = projectRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [],
      tools: [{
        name: 'large_tool',
        description: 'TOP_SECRET_VALUE',
        parameters: parameters as unknown as ToolSchema['parameters'],
      }],
    })

    expect(projection.summary.tools[0]?.parameterNodes).toBe(4096)
    expect(projection.omissions.truncatedToolSchemas).toBe(1)
  })

  it('bounds message counter keys without an unbounded omitted-key set', () => {
    const messages = Array.from({ length: 65 }, (_, index) => message(
      `message-${index}`,
      `role_${index}` as Message['role'],
      {
        kind: 'plugin',
        plugin: 'fixture',
        form: `source_${index}`,
      } as Message['source'],
      [{ type: `block_${index}` } as unknown as Message['content'][number]],
    ))

    const projection = projectRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages,
    })

    expect(Object.keys(projection.summary.messages.byRole)).toHaveLength(64)
    expect(Object.keys(projection.summary.messages.bySource)).toHaveLength(64)
    expect(Object.keys(projection.summary.messages.byBlockType)).toHaveLength(64)
    expect(projection.omissions).toMatchObject({
      messageRoles: 1,
      messageSources: 1,
      messageBlockTypes: 1,
    })
  })

  it('omits oversized structural names without retaining prefixes', () => {
    const secretName = `TOP_SECRET_${'x'.repeat(257)}`
    const projection = projectRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [message(
        'oversized',
        secretName as Message['role'],
        {
          kind: 'plugin',
          plugin: 'fixture',
          form: secretName,
        } as Message['source'],
        [{ type: secretName } as Message['content'][number]],
      )],
      tools: [{
        ...tool(),
        name: secretName,
      }],
    })

    expect(projection.summary.messages).toEqual({
      total: 1,
      byRole: {},
      bySource: {},
      byBlockType: {},
    })
    expect(projection.summary.tools).toEqual([])
    expect(projection.omissions).toMatchObject({
      requestTools: 1,
      messageRoles: 1,
      messageSources: 1,
      messageBlockTypes: 1,
      oversizedNames: 4,
    })
    expect(JSON.stringify(projection)).not.toContain(secretName)
  })
})

describe('projectPromptAssembly', () => {
  it('preserves contribution identity and size without retaining text or values', () => {
    const assembly: PromptAssembly = {
      sections: [
        { name: 'identity', text: `identity-${SECRET}` },
        { name: 'persona', text: 'brief' },
      ],
      contexts: [
        { name: 'workspace', text: `workspace-${SECRET}` },
      ],
      tools: [tool()],
      variables: {
        cwd: `/private/${SECRET}`,
        missing: undefined,
      },
    }

    const projection = projectPromptAssembly(assembly)

    expect(projection.summary).toEqual({
      sections: [
        { name: 'identity', characters: 25 },
        { name: 'persona', characters: 5 },
      ],
      contexts: [
        { name: 'workspace', characters: 26 },
      ],
      tools: ['read_file'],
      variables: ['cwd', 'missing'],
    })
    expect(projection.omissions).toEqual(ZERO_OMISSIONS)
    expect(JSON.stringify(projection)).not.toContain(SECRET)
  })

  it('bounds every prompt collection independently', () => {
    const projection = projectPromptAssembly({
      sections: Array.from({ length: 257 }, (_, index) => ({
        name: `section_${index}`,
        text: 'content',
      })),
      contexts: Array.from({ length: 257 }, (_, index) => ({
        name: `context_${index}`,
        text: 'content',
      })),
      tools: Array.from({ length: 129 }, (_, index) => ({
        ...tool(),
        name: `tool_${index}`,
      })),
      variables: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`variable_${index}`, String(index)]),
      ),
    }) as unknown as {
      readonly summary: {
        readonly sections: readonly unknown[]
        readonly contexts: readonly unknown[]
        readonly tools: readonly string[]
        readonly variables: readonly string[]
      }
      readonly omissions: {
        readonly promptSections: number
        readonly promptContexts: number
        readonly promptTools: number
        readonly promptVariables: number
      }
    }

    expect(projection.summary.sections).toHaveLength(256)
    expect(projection.summary.contexts).toHaveLength(256)
    expect(projection.summary.tools).toHaveLength(128)
    expect(projection.summary.variables).toHaveLength(256)
    expect(projection.omissions).toMatchObject({
      promptSections: 1,
      promptContexts: 1,
      promptTools: 1,
      promptVariables: 1,
    })
  })
})
