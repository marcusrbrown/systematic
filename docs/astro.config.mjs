import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import rehypeMermaid from 'rehype-mermaid'

export default defineConfig({
  site: 'https://fro.bot',
  base: '/systematic',
  trailingSlash: 'always',
  redirects: {
    '/getting-started/configuration/': '/systematic/reference/configuration/',
    '/reference/systematic-config/': '/systematic/reference/configuration/',
  },
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
              primaryBorderColor: '#59d3c8',
              lineColor: '#59d3c8',
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
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://fro.bot/systematic/og-image.png',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:width',
            content: '1200',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:height',
            content: '630',
          },
        },
      ],
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
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Reference',
          items: [
            {
              label: 'Skills',
              items: [{ autogenerate: { directory: 'reference/skills' } }],
            },
            {
              label: 'Agents',
              items: [{ autogenerate: { directory: 'reference/agents' } }],
            },
            {
              label: 'Configuration',
              link: '/reference/configuration/',
            },
          ],
        },
      ],
    }),
  ],
})
