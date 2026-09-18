; ⚠️ 本文件必须保存为「UTF-8 **带 BOM**」：makensis 3.x 遇到无 BOM 的非 ASCII
;    源码会直接报 `Bad text encoding` 并中断打包（已实测）。改完用
;    `node -e "..."` 或编辑器确认 BOM 还在；实在不想管，就把注释全改成英文。
;
; ────────────────────────────────────────────────────────────────────────────
;  智能识别已有安装位置（安装器默认目录 = 已有安装目录，直接覆盖安装）
;
;  为什么需要额外做这件事：
;    v1.2.0 换了 appId（com.jackaistudio.jackdsh → com.ljanx.agent）。NSIS 的卸载
;    注册表键 GUID 由 appId 派生，因此 electron-builder 自带的「读同 appId 的
;    InstallLocation 来定位旧版本」在跨 appId 升级时必然失效，会默认装到
;    %LOCALAPPDATA%\Programs\DeepSeek Agent，在同一台机器上留下第二份。
;
;  时机：customInit —— 在 .onInit 里、multiUser 初始化（electron-builder 自己
;        的旧安装检测）之后、目录页之前，所以这里是「跨品牌兜底」，且写进去的
;        只是默认值，用户仍可在目录页改。
;
;  检测顺序：
;    1. 命令行显式 /D=<目录> → 完全尊重用户，直接不介入；
;    2. 扫卸载表（HKCU + HKLM 64/32 位视图），DisplayName 命中本发行版品牌
;       （DeepSeek Agent / LJANX / JackDSH，含旧品牌）→ 取其 InstallLocation；
;       该值缺失时（实测 1.0.4 的键里就没有）退回 DisplayIcon —— electron-builder
;       写的是 "<安装目录>\<主程序>.exe,0"，去掉尾部 ",0" 再取父目录即可；
;    3. 注册表一无所获时，探常见安装目录（用户级 Programs、Program Files）；
;    4. 候选目录必须真实存在且含主程序 exe，才写成 $INSTDIR 默认值。
; ────────────────────────────────────────────────────────────────────────────

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define LJANX_APP_EXE "DeepSeek Agent.exe"
!define LJANX_UNINST_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"

; 脚本级变量（NSIS 必须先声明再当作 $变量 使用；这些名字不会与 electron-builder
; 模板自带的变量冲突）
Var /GLOBAL LJANX_FOUND
Var /GLOBAL LJANX_DIR
Var /GLOBAL LJANX_ICON
Var /GLOBAL LJANX_TMP
Var /GLOBAL LJANX_NAME
Var /GLOBAL LJANX_PREFIX
Var /GLOBAL LJANX_SUB
Var /GLOBAL LJANX_IDX
Var /GLOBAL LJANX_ARGS
Var /GLOBAL LJANX_OPT

; 校验候选目录并设为默认安装目录（存在 + 含主程序 exe 才算数）
!macro LJANX_TRY_DIR _DIR
  ${If} $LJANX_FOUND == "0"
    ${If} ${FileExists} "${_DIR}\${LJANX_APP_EXE}"
      StrCpy $INSTDIR "${_DIR}"
      StrCpy $LJANX_FOUND "1"
    ${EndIf}
  ${EndIf}
!macroend

; 从注册表值反推安装目录：先 InstallLocation，再 DisplayIcon（<dir>\<exe>,0）
!macro LJANX_DIR_FROM_KEY _HIVE _KEY
  ${If} $LJANX_FOUND == "0"
    ReadRegStr $LJANX_DIR "${_HIVE}" "${_KEY}" "InstallLocation"
    ${If} $LJANX_DIR != ""
      StrCpy $LJANX_TMP "$LJANX_DIR" 1             ; 首字符是引号？
      ${If} $LJANX_TMP == '"'
        StrCpy $LJANX_DIR "$LJANX_DIR" "" 1        ; 去首引号
        StrCpy $LJANX_DIR "$LJANX_DIR" -1          ; 去尾引号
      ${EndIf}
      !insertmacro LJANX_TRY_DIR "$LJANX_DIR"
    ${EndIf}
    ${If} $LJANX_FOUND == "0"
      ReadRegStr $LJANX_ICON "${_HIVE}" "${_KEY}" "DisplayIcon"
      ${If} $LJANX_ICON != ""
        StrCpy $LJANX_ICON "$LJANX_ICON" -2        ; 去掉尾部 ",0"
        StrCpy $LJANX_TMP "$LJANX_ICON" 1          ; 首字符是引号？
        ${If} $LJANX_TMP == '"'
          StrCpy $LJANX_ICON "$LJANX_ICON" "" 1    ; 去首引号
          StrCpy $LJANX_ICON "$LJANX_ICON" -1      ; 去尾引号
        ${EndIf}
        ${GetParent} "$LJANX_ICON" $LJANX_DIR
        !insertmacro LJANX_TRY_DIR "$LJANX_DIR"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; 扫一个视图下的整个卸载表，按 DisplayName 品牌前缀匹配
!macro LJANX_SCAN_HIVE _HIVE _TAG
  StrCpy $LJANX_IDX "0"
  ljanx_scan_${_TAG}:
    ${If} $LJANX_FOUND == "0"
      EnumRegKey $LJANX_SUB "${_HIVE}" "${LJANX_UNINST_ROOT}" $LJANX_IDX
      ${If} $LJANX_SUB == ""
        Goto ljanx_scan_end_${_TAG}
      ${EndIf}
      ReadRegStr $LJANX_NAME "${_HIVE}" "${LJANX_UNINST_ROOT}\$LJANX_SUB" "DisplayName"
      ${If} $LJANX_NAME != ""
        StrCpy $LJANX_PREFIX "$LJANX_NAME" 14
        ${If} $LJANX_PREFIX == "DeepSeek Agent"
          !insertmacro LJANX_DIR_FROM_KEY "${_HIVE}" "${LJANX_UNINST_ROOT}\$LJANX_SUB"
        ${Else}
          StrCpy $LJANX_PREFIX "$LJANX_NAME" 5
          ${If} $LJANX_PREFIX == "LJANX"
            !insertmacro LJANX_DIR_FROM_KEY "${_HIVE}" "${LJANX_UNINST_ROOT}\$LJANX_SUB"
          ${Else}
            StrCpy $LJANX_PREFIX "$LJANX_NAME" 7
            ${If} $LJANX_PREFIX == "JackDSH"
              !insertmacro LJANX_DIR_FROM_KEY "${_HIVE}" "${LJANX_UNINST_ROOT}\$LJANX_SUB"
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      IntOp $LJANX_IDX $LJANX_IDX + 1
      Goto ljanx_scan_${_TAG}
    ${EndIf}
  ljanx_scan_end_${_TAG}:
!macroend

!macro customInit
  StrCpy $LJANX_FOUND "0"

  ; 1) 命令行给了 /D=<目录> 就完全听用户的
  ${GetParameters} $LJANX_ARGS
  ${GetOptions} $LJANX_ARGS "/D=" $LJANX_OPT
  ${IfNot} ${Errors}
    Goto ljanx_custominit_done
  ${EndIf}

  ; 2) 扫卸载表：HKCU（本发行版的用户级安装）优先，再 HKLM 两种视图
  !insertmacro LJANX_SCAN_HIVE "HKCU" "hkcu"
  SetRegView 64
  !insertmacro LJANX_SCAN_HIVE "HKLM" "hklm64"
  SetRegView 32
  !insertmacro LJANX_SCAN_HIVE "HKLM" "hklm32"

  ; 3) 注册表没有就探常见目录（含旧品牌目录名，覆盖手工安装/便携场景）
  ${If} $LJANX_FOUND == "0"
    !insertmacro LJANX_TRY_DIR "$LOCALAPPDATA\Programs\DeepSeek Agent"
    !insertmacro LJANX_TRY_DIR "$LOCALAPPDATA\Programs\LJANX"
    !insertmacro LJANX_TRY_DIR "$LOCALAPPDATA\Programs\JackDSH"
    !insertmacro LJANX_TRY_DIR "$PROGRAMFILES64\DeepSeek Agent"
    !insertmacro LJANX_TRY_DIR "$PROGRAMFILES\DeepSeek Agent"
  ${EndIf}

  ljanx_custominit_done:
!macroend
