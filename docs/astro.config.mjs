import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  base: '/systematic',
  integrations: [
    starlight({
      title: 'Systematic',
      description: 'Structured engineering workflows for OpenCode',
      social: {
        github: 'https://github.com/marcusrbrown/systematic',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Skills',
          autogenerate: { directory: 'skills' },
        },
        {
          label: 'Agents',
          autogenerate: { directory: 'agents' },
        },
        {
          label: 'Commands',
          autogenerate: { directory: 'commands' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
      ],
    }),
  ],
})
