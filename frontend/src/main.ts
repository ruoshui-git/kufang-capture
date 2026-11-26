import { mount } from 'svelte'
import './app.css'
import { setDocumentLanguage } from '$lib/i18n/locale'
import App from './App.svelte'

setDocumentLanguage()
const app = mount(App, { target: document.getElementById('app')! })

export default app
