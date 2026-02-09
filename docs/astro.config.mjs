import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://fro.bot',
  base: '/systematic',
  trailingSlash: 'always',
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
