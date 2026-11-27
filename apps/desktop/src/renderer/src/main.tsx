import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在')

// 故意不套 StrictMode：它的双次挂载会把 xterm 实例建两遍。
createRoot(container).render(<App />)
