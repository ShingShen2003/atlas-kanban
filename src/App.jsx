import './styles.css'

// S1.2 — board layout: three columns (To Do / Doing / Done). Cards arrive in S2.1.
const COLUMNS = ['To Do', 'Doing', 'Done']

function Column({ title }) {
  return (
    <section className="column">
      <h2 className="column-title">{title}</h2>
      <div className="column-cards" aria-label={`${title} cards`}>
        {/* cards land in S2.1 */}
      </div>
    </section>
  )
}

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Atlas Kanban</h1>
      </header>
      <main className="board" aria-label="board">
        {COLUMNS.map((title) => (
          <Column key={title} title={title} />
        ))}
      </main>
    </div>
  )
}
