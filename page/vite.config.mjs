// The page builds from this folder; it imports the command's code from ../src and the measurements from ../measurements.
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
})
