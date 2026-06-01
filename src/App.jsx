import './styles.css'

// S1.1 — scaffold: boots to an empty board shell. The To Do / Doing / Done
// columns arrive in S1.2.
export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Atlas Kanban</h1>
      </header>
      <main className="board" aria-label="board">
        {/* board columns land in S1.2 */}
      </main>
    </div>
  )
}
