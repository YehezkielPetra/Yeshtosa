/** @type {importer('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./views/**/*.ejs",
    "./public/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        kue: {
          light: '#FDFBF7',
          card: '#FFFFFF',
          brand: '#C8743E',
          brandHover: '#A95E2F',
          input: '#F4EBE1'
        }
      }
    },
  },
  plugins: [],
}