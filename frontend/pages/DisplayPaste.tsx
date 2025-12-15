import React, { useEffect, useState, useTransition } from "react"

import { Button, CircularProgress, Input, Link, Tooltip } from "@heroui/react"
import chardet from "chardet"

import { useErrorModal } from "../components/ErrorModal.js"
import { DarkModeToggle, useDarkModeSelection } from "../components/DarkModeToggle.js"
import { DownloadIcon, HomeIcon, EditIcon, SaveIcon, TrashIcon, XIcon } from "../components/icons.js"
import { CopyWidget } from "../components/CopyWidget.js"
import { CodeEditor } from "../components/CodeEditor.js"

import { parseFilenameFromContentDisposition, parsePath } from "../../shared/parsers.js"
import { decodeKey, decrypt, EncryptionScheme } from "../utils/encryption.js"
import { formatSize, APIUrl, verifyExpiration, maxExpirationReadable } from "../utils/utils.js"
import { tst, inputOverrides } from "../utils/overrides.js"
import { highlightHTML, useHLJS } from "../utils/HighlightLoader.js"
import { uploadNormal, UploadOptions } from "../../shared/uploadPaste.js"
import type { MetaResponse } from "../../shared/interfaces.js"

import "../style.css"
import "../styles/highlight-theme-light.css"
import "../styles/highlight-theme-dark.css"

const utf8CompatibleEncodings = ["UTF-8", "ASCII", "ISO-8859-1"]
const DEFAULT_EXPIRATION = "7d"

export function DisplayPaste() {
  const [pasteFile, setPasteFile] = useState<File | undefined>(undefined)
  const [pasteContentBuffer, setPasteContentBuffer] = useState<ArrayBuffer | undefined>(undefined)
  const [pasteLang, setPasteLang] = useState<string | undefined>(undefined)

  const [isFileBinary, setFileBinary] = useState(false)
  const [guessedEncoding, setGuessedEncoding] = useState<string | null>(null)
  const [isDecrypted, setDecrypted] = useState<"not encrypted" | "encrypted" | "decrypted">("not encrypted")
  const [forceShowBinary, setForceShowBinary] = useState(false)
  const showFileContent = pasteFile !== undefined && (!isFileBinary || forceShowBinary)

  const [isLoading, setIsLoading] = useState<boolean>(false)

  // Edit mode states
  const [isEditMode, setIsEditMode] = useState(false)
  const [editContent, setEditContent] = useState("")
  const [editLang, setEditLang] = useState<string | undefined>(undefined)
  const [editFilename, setEditFilename] = useState<string | undefined>(undefined)
  const [editExpiration, setEditExpiration] = useState(DEFAULT_EXPIRATION)
  const [urlPassword, setUrlPassword] = useState<string | undefined>(undefined)
  const [pasteHasPassword, setPasteHasPassword] = useState<boolean | undefined>(undefined)
  const [isActionPending, startAction] = useTransition()

  const { ErrorModal, showModal, handleFailedResp } = useErrorModal()
  const [_, modeSelection, setModeSelection] = useDarkModeSelection()
  const hljs = useHLJS()

  const pasteStringContent = pasteContentBuffer && new TextDecoder().decode(pasteContentBuffer)

  const highlightedHTML = pasteStringContent ? highlightHTML(hljs, pasteLang, pasteStringContent) : ""
  const pasteLineCount = (highlightedHTML?.match(/\n/g)?.length || 0) + 1

  // uncomment the following lines for testing
  // const url = new URL("http://localhost:8787/GQbf")
  const url = new URL(location.toString())

  const { name, password: parsedPassword, ext, filename } = parsePath(url.pathname)

  // Extract password from URL if present (format: /d/name:password)
  useEffect(() => {
    if (parsedPassword) {
      setUrlPassword(parsedPassword)
    }
  }, [parsedPassword])

  useEffect(() => {
    const pasteUrl = `${APIUrl}/${name}`
    const metaUrl = `${APIUrl}/m/${name}`

    const fetchPaste = async () => {
      try {
        setIsLoading(true)

        // Fetch metadata first to check if paste has password
        const metaResp = await fetch(metaUrl)
        if (metaResp.ok) {
          const meta: MetaResponse = await metaResp.json()
          setPasteHasPassword(meta.hasPassword ?? false)
        }

        const resp = await fetch(pasteUrl)
        if (!resp.ok) {
          await handleFailedResp("Failed to Fetch Paste", resp)
          return
        }

        const scheme: EncryptionScheme | null = resp.headers.get("X-PB-Encryption-Scheme") as EncryptionScheme | null
        let filenameFromDisp = resp.headers.has("Content-Disposition")
          ? parseFilenameFromContentDisposition(resp.headers.get("Content-Disposition")!) || undefined
          : undefined
        if (filenameFromDisp && scheme !== null) {
          filenameFromDisp = filenameFromDisp.replace(/.encrypted$/, "")
        }

        const lang = url.searchParams.get("lang") || resp.headers.get("X-PB-Highlight-Language")

        const inferredFilename = filename || (ext && name + ext) || filenameFromDisp
        const respBytes = await resp.bytes()
        setPasteLang(lang || undefined)

        const keyString = url.hash.slice(1)
        if (scheme === null || keyString.length === 0) {
          setPasteFile(new File([respBytes], inferredFilename || name))
          setPasteContentBuffer(respBytes)
          if (scheme) {
            setDecrypted("encrypted")
            setFileBinary(true)
          } else {
            const encoding = chardet.detect(respBytes)
            setFileBinary(encoding === null || !utf8CompatibleEncodings.includes(encoding))
            setGuessedEncoding(encoding)
          }
        } else {
          let key: CryptoKey | undefined
          try {
            key = await decodeKey(scheme, keyString)
          } catch {
            showModal("Error", `Failed to parse "${keyString}" as ${scheme} key`)
            return
          }
          if (key === undefined) {
            showModal("Error", `Failed to parse "${keyString}" as ${scheme} key`)
            return
          }

          const decrypted = await decrypt(scheme, key, respBytes)
          if (decrypted === null) {
            showModal("Error", "Failed to decrypt content")
            return
          }

          setPasteFile(new File([decrypted], inferredFilename || name))
          setPasteContentBuffer(decrypted)
          setPasteLang(lang || undefined)

          const encoding = chardet.detect(decrypted)
          setFileBinary(encoding === null || !utf8CompatibleEncodings.includes(encoding))
          setDecrypted("decrypted")
          setGuessedEncoding(encoding)
        }
      } finally {
        setIsLoading(false)
      }
    }
    fetchPaste().catch((e) => {
      showModal(`Error on fetching ${pasteUrl}`, (e as Error).toString())
      console.error(e)
    })
  }, [])

  // Enter edit mode
  function onEnterEditMode() {
    if (pasteStringContent) {
      setEditContent(pasteStringContent)
      setEditLang(pasteLang)
      setEditFilename(pasteFile?.name)
      setIsEditMode(true)
    }
  }

  // Cancel edit mode
  function onCancelEdit() {
    setIsEditMode(false)
    setEditContent("")
  }

  // Get manage URL based on whether paste has password
  function getManageUrl(): string {
    if (pasteHasPassword && urlPassword) {
      return `${APIUrl}/${name}:${urlPassword}`
    } else if (!pasteHasPassword) {
      // No password set, use empty password
      return `${APIUrl}/${name}:`
    }
    return ""
  }

  // Update paste
  function onUpdatePaste() {
    const manageUrl = getManageUrl()
    if (!manageUrl) {
      showModal("Error", "No manage password available. Cannot update paste.")
      return
    }

    startAction(async () => {
      try {
        const options: UploadOptions = {
          content: new File([editContent], editFilename || ""),
          isUpdate: true,
          expire: editExpiration,
          highlightLanguage: editLang,
          manageUrl,
        }

        const resp = await uploadNormal(APIUrl, options)
        const expireMessage = resp.isPermanent ? "Never (permanent)" : new Date(resp.expireAt).toLocaleString()
        showModal("Updated Successfully", `Paste updated. Expires at: ${expireMessage}`)

        // Update displayed content
        const newBuffer = new TextEncoder().encode(editContent)
        setPasteContentBuffer(newBuffer)
        setPasteFile(new File([newBuffer], editFilename || name))
        setPasteLang(editLang)
        setIsEditMode(false)
      } catch (e) {
        showModal("Error on Update", (e as Error).message)
      }
    })
  }

  // Delete paste
  function onDeletePaste() {
    const manageUrl = getManageUrl()
    if (!manageUrl) {
      showModal("Error", "No manage password available. Cannot delete paste.")
      return
    }

    if (!confirm("Are you sure you want to delete this paste?")) {
      return
    }

    startAction(async () => {
      try {
        const resp = await fetch(manageUrl, { method: "DELETE" })
        if (resp.ok) {
          showModal("Deleted Successfully", "Paste has been deleted. Redirecting to home...")
          setTimeout(() => {
            window.location.href = "/"
          }, 2000)
        } else {
          await handleFailedResp("Error on Delete Paste", resp)
        }
      } catch (e) {
        showModal("Error on Delete", (e as Error).message)
      }
    })
  }

  const binaryFileIndicator = pasteFile && (
    <div className="absolute top-[50%] left-[50%] translate-[-50%] flex flex-col items-center w-full">
      <div className="text-foreground-600 mb-2">{`${pasteFile?.name} (${formatSize(pasteFile.size)})`}</div>
      <div className="w-fit text-center">
        This file seems to be binary or not in UTF-8{guessedEncoding ? ` (${guessedEncoding} guessed). ` : ". "}
        <button className="text-primary-500 inline" onClick={() => setForceShowBinary(true)}>
          (Click to show)
        </button>
      </div>
    </div>
  )

  const lineNumOffset = `${Math.floor(Math.log10(pasteLineCount)) + 3}ch`
  const buttonClasses = `rounded-full bg-background hover:bg-default-100 ${tst}`

  // Check if user can edit (content is text and not encrypted)
  const canEdit = showFileContent && !isFileBinary && isDecrypted !== "encrypted"

  // Determine if user has manage access:
  // 1. If paste has no password -> always has access
  // 2. If paste has password and URL has password -> has access
  // 3. If paste has password but URL has no password -> no access
  const hasManageAccess = pasteHasPassword === false || (pasteHasPassword === true && !!urlPassword)

  // Show buttons only when we know the password status
  const showManageButtons = pasteHasPassword !== undefined && hasManageAccess

  return (
    <main
      className={`flex flex-col items-center min-h-screen transition-transform-background bg-background ${tst} text-foreground w-full p-2`}
    >
      <div className="w-full max-w-[64rem]">
        <div className="flex flex-row my-4 items-center justify-between">
          <h1 className="text-xl md:text-2xl grow inline-flex items-baseline">
            <Link href="/" className="text-foreground-500 text-[length:inherited]">
              <Button isIconOnly aria-label={INDEX_PAGE_TITLE} className={buttonClasses + " md:hidden"}>
                <HomeIcon className="size-6" />
              </Button>
              <span className="hidden md:inline">{INDEX_PAGE_TITLE}</span>
            </Link>
            <span className="mx-2">{" / "}</span>
            <code>{name}</code>
            <span className="ml-1">
              {isDecrypted === "decrypted" ? " (Decrypted)" : isDecrypted === "encrypted" ? " (Encrypted)" : ""}
            </span>
          </h1>
          {!isEditMode && showFileContent && (
            <Tooltip content={`Copy to clipboard`}>
              <CopyWidget className={buttonClasses} getCopyContent={() => pasteStringContent!} />
            </Tooltip>
          )}
          {!isEditMode && pasteFile && (
            <Tooltip content={`Download as file`}>
              <Button aria-label="Download" isIconOnly className={buttonClasses}>
                <a href={URL.createObjectURL(pasteFile)} download={pasteFile.name}>
                  <DownloadIcon className="size-6 inline" />
                </a>
              </Button>
            </Tooltip>
          )}
          {!isEditMode && canEdit && showManageButtons && (
            <Tooltip content="Edit paste">
              <Button
                aria-label="Edit"
                isIconOnly
                className={buttonClasses}
                onPress={onEnterEditMode}
              >
                <EditIcon className="size-6" />
              </Button>
            </Tooltip>
          )}
          {!isEditMode && showManageButtons && (
            <Tooltip content="Delete paste">
              <Button
                aria-label="Delete"
                isIconOnly
                className={`${buttonClasses} text-danger`}
                onPress={onDeletePaste}
                isDisabled={isActionPending}
              >
                <TrashIcon className="size-6" />
              </Button>
            </Tooltip>
          )}
          <DarkModeToggle modeSelection={modeSelection} setModeSelection={setModeSelection} />
        </div>

        {/* Edit Mode */}
        {isEditMode ? (
          <div className="my-4">
            <CodeEditor
              content={editContent}
              setContent={setEditContent}
              lang={editLang}
              setLang={setEditLang}
              filename={editFilename}
              setFilename={setEditFilename}
              placeholder="Edit your paste here"
            />
            <div className="mt-4 flex flex-row gap-4 items-end">
              <Input
                type="text"
                label="New Expiration"
                classNames={{ base: "max-w-[12rem]", ...inputOverrides }}
                value={editExpiration}
                onValueChange={setEditExpiration}
                isInvalid={!verifyExpiration(editExpiration)[0]}
                errorMessage={verifyExpiration(editExpiration)[1]}
                description={verifyExpiration(editExpiration)[1]}
              />
              <div className="flex gap-2">
                <Button
                  color="primary"
                  onPress={onUpdatePaste}
                  isDisabled={isActionPending || !verifyExpiration(editExpiration)[0]}
                  startContent={isActionPending ? <CircularProgress size="sm" /> : <SaveIcon className="size-5" />}
                >
                  {isActionPending ? "Saving..." : "Save"}
                </Button>
                <Button
                  color="default"
                  variant="bordered"
                  onPress={onCancelEdit}
                  isDisabled={isActionPending}
                  startContent={<XIcon className="size-5" />}
                >
                  Cancel
                </Button>
              </div>
            </div>
            <p className="mt-2 text-small text-foreground-500">
              Max expiration: {maxExpirationReadable}
            </p>
          </div>
        ) : (
          /* View Mode */
          <div className="my-4">
            <div className={`w-full bg-default-100 rounded-lg p-3 relative ${tst}`}>
              {isLoading ? (
                <div className={"h-[10em]"}>
                  <CircularProgress
                    className="h-[10em] absolute top-[50%] left-[50%] translate-[-50%]"
                    label={"Loading..."}
                  />
                </div>
              ) : (
                pasteFile && (
                  <div className={showFileContent ? "" : "h-[10em]"}>
                    {showFileContent ? (
                      <>
                        <div className="text-foreground-600 mb-2 text-small flex flex-row gap-2">
                          <span>{pasteFile?.name}</span>
                          <span>{`(${formatSize(pasteFile.size)})`}</span>
                          {forceShowBinary && (
                            <button className="ml-2 text-primary-500" onClick={() => setForceShowBinary(false)}>
                              (Click to hide)
                            </button>
                          )}
                          {pasteLang && <span className={"grow text-right"}>{pasteLang}</span>}
                        </div>
                        <div className="font-mono relative" role="article">
                          <pre
                            style={{ marginLeft: lineNumOffset, width: `calc(100% - ${lineNumOffset})` }}
                            dangerouslySetInnerHTML={{ __html: highlightedHTML }}
                            className={"overflow-x-auto"}
                          />
                          <span
                            className={
                              "line-number-rows absolute pointer-events-none text-default-500 top-0 left-0 " +
                              "border-solid border-default-300 border-r-1"
                            }
                          >
                            {Array.from({ length: pasteLineCount }, (_, idx) => {
                              return <span key={idx} />
                            })}
                          </span>
                        </div>
                      </>
                    ) : (
                      binaryFileIndicator
                    )}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
      <ErrorModal />
    </main>
  )
}
