// @x-code/cli — askUser multi-select interaction component
import React, { useState } from 'react'

import { Box, Text, useInput } from 'ink'

interface Option {
  label: string
  description: string
}

interface SelectOptionsProps {
  question: string
  options: Option[]
  onSelect: (answer: string) => void
}

export function SelectOptions({ question, options, onSelect }: SelectOptionsProps) {
  // Append "Other" option
  const allOptions = [...options, { label: 'Other', description: 'Custom input' }]
  const [selected, setSelected] = useState(0)
  const [customInput, setCustomInput] = useState('')
  const [isCustomMode, setIsCustomMode] = useState(false)

  useInput((input, key) => {
    if (isCustomMode) {
      if (key.return) {
        onSelect(customInput || 'Other')
        return
      }
      if (key.backspace || key.delete) {
        setCustomInput((prev) => prev.slice(0, -1))
        return
      }
      if (key.escape) {
        setIsCustomMode(false)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setCustomInput((prev) => prev + input)
      }
      return
    }

    if (key.upArrow) {
      setSelected((prev) => (prev > 0 ? prev - 1 : allOptions.length - 1))
    } else if (key.downArrow) {
      setSelected((prev) => (prev < allOptions.length - 1 ? prev + 1 : 0))
    } else if (key.return) {
      if (selected === allOptions.length - 1) {
        // "Other" selected
        setIsCustomMode(true)
      } else {
        onSelect(allOptions[selected].label)
      }
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        ? {question}
      </Text>
      {!isCustomMode ? (
        allOptions.map((opt, i) => (
          <Box key={i}>
            <Text color={i === selected ? 'cyan' : undefined}>
              {i === selected ? '> ' : '  '}
              {opt.label}
            </Text>
            <Text dimColor> — {opt.description}</Text>
          </Box>
        ))
      ) : (
        <Box>
          <Text color="cyan">{'> '}</Text>
          <Text>{customInput}</Text>
          <Text dimColor>█</Text>
        </Box>
      )}
      <Text dimColor>{isCustomMode ? 'Enter to confirm, Esc to go back' : '↑↓ Navigate  Enter Confirm'}</Text>
    </Box>
  )
}
