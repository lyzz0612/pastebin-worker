import React, { useState, useTransition } from "react"

import { Button, Link } from "@heroui/react"

import { DarkModeToggle, useDarkModeSelection } from "../components/DarkModeToggle.js"
import { useErrorModal } from "../components/ErrorModal.js"
import { PanelSettingsPanel, PasteSetting } from "../components/PasteSettingPanel.js"
import { UploadedPanel } from "../components/UploadedPanel.js"
import { PasteInputPanel, PasteEditState } from "../components/PasteInputPanel.js"

import type { PasteResponse } from "../../shared/interfaces.js"

import {
  verifyExpiration,
  verifyName,
  maxExpirationReadable,
  BaseUrl,
} from "../utils/utils.js"
import { uploadPaste } from "../utils/uploader.js"
import { tst } from "../utils/overrides.js"

import "../style.css"

export function PasteBin() {
  const [editorState, setEditorState] = useState<PasteEditState>({
    editKind: "edit",
    editContent: "",
    file: null,
    editHighlightLang: "plaintext",
  })

  const [pasteSetting, setPasteSetting] = useState<PasteSetting>({
    expiration: DEFAULT_EXPIRATION,
    name: "",
    usePassword: false,
    password: "",
    uploadKind: "short",
    doEncrypt: false,
  })

  const [pasteResponse, setPasteResponse] = useState<PasteResponse | undefined>(undefined)
  const [uploadedEncryptionKey, setUploadedEncryptionKey] = useState<string | undefined>(undefined)
  const [uploadedWithPassword, setUploadedWithPassword] = useState(false)

  const [isUploadPending, startUpload] = useTransition()
  const [loadingProgress, setLoadingProgress] = useState<number | undefined>(undefined)

  const [_, modeSelection, setModeSelection] = useDarkModeSelection()

  const { ErrorModal, handleError } = useErrorModal()

  function onStartUpload() {
    startUpload(async () => {
      try {
        const uploaded = await uploadPaste(
          pasteSetting,
          editorState,
          setUploadedEncryptionKey,
          setLoadingProgress
        )
        setPasteResponse(uploaded)
        setUploadedWithPassword(pasteSetting.usePassword)
      } catch (e) {
        handleError("Error on Uploading Paste", e as Error)
      }
    })
  }

  function canUpload(): boolean {
    if (editorState.editKind === "edit" && editorState.editContent.length === 0) {
      return false
    } else if (editorState.editKind === "file" && editorState.file === null) {
      return false
    }

    if (verifyExpiration(pasteSetting.expiration)[0]) {
      if (pasteSetting.uploadKind === "short" || pasteSetting.uploadKind === "long") {
        return true
      } else if (pasteSetting.uploadKind === "custom") {
        return verifyName(pasteSetting.name)[0]
      } else {
        return false
      }
    } else {
      return false
    }
  }

  const info = (
    <div className="mx-4 lg:mx-0">
      <div className="mt-8 mb-4 relative">
        <h1 className="text-3xl inline">{INDEX_PAGE_TITLE}</h1>
        <DarkModeToggle
          modeSelection={modeSelection}
          setModeSelection={setModeSelection}
          className="absolute right-0"
        />
      </div>
      <p className="my-2">An open source pastebin deployed on Cloudflare Workers. </p>
      <p className="my-2">
        <b>Usage</b>: Paste text or file here. Upload. Share it with a URL. Or access with our{" "}
        <Link className={tst} href={`${BaseUrl}/api`}>
          APIs
        </Link>
        .
      </p>
      <p className="my-2">
        <b>Warning</b>: Only for temporary share <b>(max {maxExpirationReadable})</b>. Files could be deleted without
        notice!
      </p>
    </div>
  )

  const submitter = (
    <div className="my-4 mx-2 lg:mx-0">
      <Button
        color="primary"
        onPress={onStartUpload}
        className={`mr-4 ${tst}`}
        isDisabled={!canUpload() || isUploadPending}
      >
        Upload
      </Button>
    </div>
  )

  const footer = (
    <footer className="px-3 my-4 text-center">
      <p>
        <Link href={`${BaseUrl}/tos`} className={`d-inline-block ${tst}`}>
          Terms & Conditions
        </Link>
        {" / "}
        <Link href={REPO} className={`d-inline-block ${tst}`}>
          Repository
        </Link>
      </p>
    </footer>
  )

  return (
    <main className={`flex flex-col items-center min-h-screen font-sans ${tst} bg-background text-foreground`}>
      <div className="grow w-full max-w-[64rem]">
        {info}
        <PasteInputPanel
          isPasteLoading={false}
          state={editorState}
          onStateChange={setEditorState}
          className="mt-6 mb-4 mx-2 lg:mx-0"
        />
        <div className="flex flex-col items-start lg:flex-row gap-4 mx-2 lg:mx-0">
          <PanelSettingsPanel
            className={"transition-width lg:w-1/2 w-full"}
            setting={pasteSetting}
            onSettingChange={setPasteSetting}
          />
          {(pasteResponse || isUploadPending) && (
            <UploadedPanel
              isLoading={isUploadPending}
              loadingProgress={loadingProgress}
              pasteResponse={pasteResponse}
              encryptionKey={uploadedEncryptionKey}
              hasPassword={uploadedWithPassword}
              className="w-full lg:w-1/2"
            />
          )}
        </div>
        {submitter}
      </div>
      {footer}
      <ErrorModal />
    </main>
  )
}
