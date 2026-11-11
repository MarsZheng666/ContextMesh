import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export function powershellCommand(script: string) {
  return {
    executable: win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(
        "$ErrorActionPreference='Stop'; $env:PSModulePath=[System.IO.Path]::Combine($PSHOME, 'Modules'); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n" +
          script,
        'utf16le',
      ).toString('base64'),
    ],
  }
}
export async function powershell(
  script: string,
  env: NodeJS.ProcessEnv = {},
  options: { signal?: AbortSignal; timeout?: number } = {},
) {
  const command = powershellCommand(script)
  return execute(command.executable, command.args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 128 * 1024,
    ...options,
    env: { ...process.env, ...env },
  })
}

/** NTFS ACLs, not Node's synthetic POSIX mode, protect Windows credentials. */
export async function windowsPrivatePath(path: string, create = false) {
  await powershell(
    `
$path = $env:CM_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
$acl = Get-Acl -LiteralPath $path
if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Private path has another owner' }
if ($env:CM_PRIVATE_CREATE -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = if ((Get-Item -LiteralPath $path).PSIsContainer) { 'ContainerInherit, ObjectInherit' } else { 'None' }
  foreach ($id in $allowed) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($id)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
  $acl = Get-Acl -LiteralPath $path
}
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'Private path grants access to another user' }
}
`,
    { CM_PRIVATE_PATH: path, CM_PRIVATE_CREATE: create ? '1' : '0' },
  ).catch((cause: unknown) => {
    throw new Error(
      'ContextMesh needs a private NTFS directory accessible only to your Windows account, SYSTEM and Administrators: ' +
        path,
      { cause },
    )
  })
}
