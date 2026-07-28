import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import rehypeMermaid from 'rehype-mermaid'
import remarkGfm from 'remark-gfm'

export default defineConfig({
  site: 'https://fro.bot',
  base: '/systematic',
  trailingSlash: 'always',
  redirects: {
    '/getting-started/configuration/': '/systematic/reference/configuration/',
    '/reference/systematic-config/': '/systematic/reference/configuration/',
    // Quick Start merged into Installation; keep the old URL alive.
    '/getting-started/quick-start/':
      '/systematic/getting-started/installation/',
    // Pi and Claude Code harness guides folded into Installation.
    '/guides/pi-harness/': '/systematic/getting-started/installation/',
    '/guides/claude-code-harness/': '/systematic/getting-started/installation/',
  },
  markdown: {
    remarkPlugins: [remarkGfm],
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
      favicon: '/favicon.svg',
      description:
        'Systematic is a compound-engineering loop — brainstorm, plan, work, and review — delivered as bundled skills and agents for OpenCode, Pi, and Claude Code.',
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
        {
          tag: 'meta',
          attrs: {
            property: 'og:type',
            content: 'website',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:site_name',
            content: 'Systematic',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:card',
            content: 'summary_large_image',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content: 'https://fro.bot/systematic/og-image.png',
          },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareSourceCode',
            name: 'Systematic',
            description:
              'A compound-engineering loop — brainstorm, plan, work, and review — delivered as bundled skills and agents for OpenCode, Pi, and Claude Code.',
            codeRepository: 'https://github.com/marcusrbrown/systematic',
            license: 'https://opensource.org/licenses/MIT',
            programmingLanguage: 'TypeScript',
            keywords: ['opencode', 'plugin', 'ai', 'workflow', 'engineering'],
            author: {
              '@type': 'Person',
              name: 'Marcus R. Brown',
              url: 'https://github.com/marcusrbrown',
            },
          }),
        },
        ...(process.env.UMAMI_WEBSITE_ID
          ? [
              {
                tag: 'script',
                attrs: {
                  src: 'https://metrics.fro.bot/script.js',
                  defer: true,
                  'data-website-id': process.env.UMAMI_WEBSITE_ID,
                  'data-do-not-track': 'true',
                  'data-exclude-search': 'true',
                  'data-exclude-hash': 'true',
                },
              },
            ]
          : []),
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/marcusrbrown/systematic',
        },
      ],
      components: {
        Footer: './src/components/CustomFooter.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
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
