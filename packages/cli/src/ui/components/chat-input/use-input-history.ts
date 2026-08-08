import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { HISTORY_MAX, appendInputHistory, loadInputHistory } from '../../input-history.js'
import type { InputHistoryEntry } from '../../input-history.js'
import type { PastedContents } from '../../paste-refs.js'
import type { InputAction } from './reducer.js'

interface UseInputHistoryOptions {
  text: string
  cursorRef: MutableRefObject<number>
  pastedContents: PastedContents
  dispatch: Dispatch<InputAction>
  setPastedContents: Dispatch<SetStateAction<PastedContents>>
  setCompletionIndex: Dispatch<SetStateAction<number>>
  setAtCompletionIndex: Dispatch<SetStateAction<number>>
}

export function useInputHistory({
  text,
  cursorRef,
  pastedContents,
  dispatch,
  setPastedContents,
  setCompletionIndex,
  setAtCompletionIndex,
}: UseInputHistoryOptions) {
  // Navigation counters stay synchronous so rapid Up/Down presses never
  // observe a React-state value from the previous render. History keeps the
  // compact paste-reference form; restoring expanded pastes would flood the
  // input box with the original content.
  const historyRef = useRef<InputHistoryEntry[]>([])
  const historyIndexRef = useRef(0)
  const historyDraftRef = useRef<{ text: string; cursor: number; pasted: PastedContents } | null>(null)
  // Pin storage to the launch directory so a tool-driven `cd` cannot split a
  // session's reads and writes across two project history files.
  const initialCwdRef = useRef(process.cwd())

  useEffect(() => {
    let cancelled = false
    void loadInputHistory(initialCwdRef.current).then((entries) => {
      if (cancelled) return
      historyRef.current = entries
    })
    return () => {
      cancelled = true
    }
  }, [])

  const resetHistoryNav = () => {
    historyIndexRef.current = 0
    historyDraftRef.current = null
  }

  const pushHistory = (raw: string, pasted: PastedContents) => {
    if (!raw.trim()) return
    const last = historyRef.current[historyRef.current.length - 1]
    if (last && last.text === raw) return
    const entry: InputHistoryEntry = { text: raw, pasted: { ...pasted }, ts: Date.now() }
    historyRef.current.push(entry)
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift()
    void appendInputHistory(entry, initialCwdRef.current)
  }

  const restoreHistoryEntry = (entry: { text: string; pasted: PastedContents }, cursorAt: 'start' | 'end') => {
    dispatch({ type: 'SET_TEXT', text: entry.text, cursor: cursorAt === 'start' ? 0 : entry.text.length })
    setPastedContents({ ...entry.pasted })
    setCompletionIndex(0)
    setAtCompletionIndex(0)
  }

  const navigateHistoryUp = () => {
    if (historyRef.current.length === 0) return
    if (historyIndexRef.current >= historyRef.current.length) return
    if (historyIndexRef.current === 0) {
      historyDraftRef.current = {
        text,
        cursor: cursorRef.current,
        pasted: { ...pastedContents },
      }
    }
    historyIndexRef.current += 1
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'start')
  }

  const navigateHistoryDown = () => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    if (historyIndexRef.current === 0) {
      const draft = historyDraftRef.current
      historyDraftRef.current = null
      if (draft) {
        dispatch({ type: 'SET_TEXT', text: draft.text, cursor: draft.cursor })
        setPastedContents({ ...draft.pasted })
      } else {
        dispatch({ type: 'RESET' })
        setPastedContents({})
      }
      setCompletionIndex(0)
      setAtCompletionIndex(0)
      return
    }
    const entry = historyRef.current[historyRef.current.length - historyIndexRef.current]
    if (entry) restoreHistoryEntry(entry, 'end')
  }

  const isNavigatingHistory = () => historyIndexRef.current > 0

  return { isNavigatingHistory, navigateHistoryDown, navigateHistoryUp, pushHistory, resetHistoryNav }
}
