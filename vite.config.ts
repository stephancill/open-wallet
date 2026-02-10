import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // whatsabi currently references process.env in browser bundles.
  // Vite doesn't polyfill `process`, so we inline an empty env object.
  define: {
    'process.env': {},
  },
})
