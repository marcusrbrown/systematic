import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import rehypeMermaid from 'rehype-mermaid'

export default defineConfig({
  site: 'https://fro.bot',
  base: '/systematic',
  trailingSlash: 'always',
  markdown: {
    rehypePlugins: [
      [
        rehypeMermaid,
        {
          strategy: 'img-svg',
          mermaidConfig: {
            theme: 'dark',
            themeVariables: {
              primaryColor: '#1a1a2e',
              primaryTextColor: '#fff',
              primaryBorderColor: '#4FD1C5',
              lineColor: '#4FD1C5',
              secondaryColor: '#16213e',
              tertiaryColor: '#0f0f23',
            },
          },
        },
      ],
    ],
  },
  integrations: [
    starlight({
      title: 'Systematic',
      description: 'Structured engineering workflows for OpenCode',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/marcusrbrown/systematic',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Reference',
          items: [
            {
              label: 'Skills',
              autogenerate: { directory: 'reference/skills' },
            },
            {
              label: 'Agents',
              autogenerate: { directory: 'reference/agents' },
            },
            {
              label: 'Commands',
              autogenerate: { directory: 'reference/commands' },
            },
          ],
        },
      ],
    }),
  ],
})
