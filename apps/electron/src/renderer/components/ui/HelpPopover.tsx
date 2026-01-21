/**
 * HelpPopover
 *
 * Contextual help popover that displays a feature summary with a "Learn more" link
 * to the full documentation. Triggered by a help icon button.
 */

import * as React from 'react'
import { CircleHelp, ExternalLink } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Button } from './button'
import { HeaderIconButton } from './HeaderIconButton'
import { type DocFeature, getDocInfo, getDocUrl } from '@craft-agent/shared/docs/doc-links'

interface HelpPopoverProps {
  /** The documentation feature to show help for */
  feature: DocFeature
  /** Optional custom trigger element. Defaults to a help icon button. */
  trigger?: React.ReactNode
  /** Side of the trigger to show the popover. Defaults to 'bottom'. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Alignment of the popover. Defaults to 'end'. */
  align?: 'start' | 'center' | 'end'
}

export function HelpPopover({
  feature,
  trigger,
  side = 'bottom',
  align = 'end',
}: HelpPopoverProps) {
  const docInfo = getDocInfo(feature)
  const docUrl = getDocUrl(feature)

  const handleLearnMore = React.useCallback(() => {
    window.electronAPI?.openUrl(docUrl)
  }, [docUrl])

  const defaultTrigger = (
    <HeaderIconButton
      icon={<CircleHelp className="size-4" />}
      tooltip="Help"
    />
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? defaultTrigger}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-72"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {docInfo.summary}
          </p>
          <div className="flex justify-end">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs font-medium"
              onClick={handleLearnMore}
            >
              Learn more
              <ExternalLink className="ml-1 size-3" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
