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
              primaryColor: '#182225',
              primaryTextColor: '#f3f6f7',
              primaryBorderColor: '#4fd1c5',
              lineColor: '#4fd1c5',
              secondaryColor: '#243033',
              tertiaryColor: '#101719',
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
              label: 'User Configuration',
              link: '/reference/systematic-config/',
            },
          ],
        },
      ],
    }),
  ],
})
