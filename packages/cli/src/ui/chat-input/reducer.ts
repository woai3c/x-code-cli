// Reducer for atomic text + cursor updates in ChatInput.
//
// All mutations to the input buffer go through `useReducer(inputReducer)`
// so a single keypress that both edits text AND moves the cursor commits
// as one state transition (no intermediate frame where the cursor is in
// the wrong place).

export interface InputState {
  text: string
  cursor: number
}

export type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action
      return {
        text: state.text.slice(0, pos) + chunk + state.text.slice(pos),
        cursor: pos + chunk.length,
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action
      if (pos === 0) return state
      return {
        text: state.text.slice(0, pos - deleteCount) + state.text.slice(pos),
        cursor: pos - deleteCount,
      }
    }
    case 'DELETE': {
      const { pos } = action
      if (pos >= state.text.length) return state
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor }
    }
    case 'SET_CURSOR':
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor }
    case 'SET_TEXT':
      return { text: action.text, cursor: action.cursor }
    case 'RESET':
      return { text: '', cursor: 0 }
    default:
      return state
  }
}
