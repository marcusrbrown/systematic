declare module '@opencode-ai/plugin/tool' {
  interface ToolSchemaBuilder {
    string(): { describe(desc: string): ToolSchemaBuilder }
  }

  interface ToolArgs {
    [key: string]: ToolSchemaBuilder
  }

  interface ToolDefinition<TArgs extends ToolArgs> {
    description: string
    args: TArgs
    execute: (
      args: { [K in keyof TArgs]: string },
      context: unknown,
    ) => Promise<string>
  }

  interface ToolFunction {
    <TArgs extends ToolArgs>(definition: ToolDefinition<TArgs>): unknown
    schema: ToolSchemaBuilder
  }

  export const tool: ToolFunction
}
