import React from "react"

import { Card, CardBody, CardHeader, CardProps, CircularProgress, Divider, Input, mergeClasses } from "@heroui/react"

import type { PasteResponse } from "../../shared/interfaces.js"
import { tst } from "../utils/overrides.js"
import { CopyWidget } from "./CopyWidget.js"

interface UploadedPanelProps extends CardProps {
  isLoading: boolean
  loadingProgress?: number
  pasteResponse?: PasteResponse
  encryptionKey?: string
  hasPassword?: boolean
}

// Build display URL: /d/name or /d/name:password with optional encryption key hash
const makeDisplayUrl = (url: string, manageUrl: string, hasPassword: boolean, encryptionKey?: string) => {
  // If has password, use manageUrl which contains name:password
  // Otherwise use url which contains just name
  const baseUrl = hasPassword ? manageUrl : url
  const urlParsed = new URL(baseUrl)
  urlParsed.pathname = "/d" + urlParsed.pathname
  if (encryptionKey) {
    return urlParsed.toString() + "#" + encryptionKey
  }
  return urlParsed.toString()
}

export function UploadedPanel({
  isLoading,
  loadingProgress,
  pasteResponse,
  className,
  encryptionKey,
  hasPassword = false,
  ...rest
}: UploadedPanelProps) {
  const copyWidgetClassNames = `bg-transparent ${tst} translate-y-[10%]`
  const inputProps = {
    "aria-labelledby": "",
    readOnly: true,
    className: "mb-2",
  }

  const displayUrl = pasteResponse
    ? makeDisplayUrl(pasteResponse.url, pasteResponse.manageUrl, hasPassword, encryptionKey)
    : ""

  return (
    <Card classNames={mergeClasses({ base: tst }, { base: className })} {...rest}>
      <CardHeader className="text-2xl pl-4 pb-2">Uploaded Paste</CardHeader>
      <Divider />
      <CardBody>
        {isLoading ? (
          <div className={"min-h-[5rem] w-full relative"}>
            <CircularProgress
              aria-label={"Loading..."}
              value={loadingProgress}
              className={"absolute top-[50%] left-[50%] translate-[-50%]"}
            />
          </div>
        ) : (
          pasteResponse && (
            <>
              <Input
                {...inputProps}
                label={"Display URL"}
                color={encryptionKey ? "success" : "default"}
                value={displayUrl}
                endContent={
                  <CopyWidget
                    className={copyWidgetClassNames}
                    getCopyContent={() => displayUrl}
                  />
                }
              />
              <Input
                {...inputProps}
                label={"Raw URL"}
                value={pasteResponse.url}
                endContent={<CopyWidget className={copyWidgetClassNames} getCopyContent={() => pasteResponse.url} />}
              />
              <Input {...inputProps} label={"Expiration"} value={new Date(pasteResponse.expireAt).toLocaleString()} />
              <p className="text-small text-success-600 mt-2">
                ✓ Uploaded successfully!
              </p>
            </>
          )
        )}
      </CardBody>
    </Card>
  )
}
