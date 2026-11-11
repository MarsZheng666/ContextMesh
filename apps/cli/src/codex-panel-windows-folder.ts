import { powershell } from '../../../packages/platform/src/windows.js'

// IFileOpenDialog with FOS_PICKFOLDERS uses the Windows common item dialog.
// The selected path is returned by the shell; no browser upload or WSL translation.
export const windowsFolderScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ContextMeshFolder {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class DialogClass {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Item {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out Item parent);
    void GetDisplayName(uint sigdn, out IntPtr name);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(Item other, uint hint, out int order);
  }
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Dialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(Item folder);
    void SetFolder(Item folder);
    void GetFolder(out Item folder);
    void GetCurrentSelection(out Item item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out Item item);
    void AddPlace(Item item, uint placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out Item item);
  public static string Choose(string initial) {
    var dialog = (Dialog)new DialogClass();
    Item folder = null, result = null;
    IntPtr name = IntPtr.Zero;
    try {
      dialog.SetOptions(0x20 | 0x40 | 0x800 | 0x8);
      dialog.SetTitle("Choose a Project Folder");
      if (!String.IsNullOrEmpty(initial)) {
        var iid = typeof(Item).GUID;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
        dialog.SetFolder(folder);
      }
      int status = dialog.Show(IntPtr.Zero);
      if (status == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(status);
      dialog.GetResult(out result);
      result.GetDisplayName(0x80058000, out name);
      return Marshal.PtrToStringUni(name);
    } finally {
      if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
      if (result != null) Marshal.FinalReleaseComObject(result);
      if (folder != null) Marshal.FinalReleaseComObject(folder);
      Marshal.FinalReleaseComObject(dialog);
    }
  }
}
'@
$folder = [ContextMeshFolder]::Choose($env:CM_INITIAL_FOLDER)
ConvertTo-Json -InputObject $folder -Compress
`

export async function chooseWindowsFolder(
  initial?: string,
  signal?: AbortSignal,
) {
  return powershell(
    windowsFolderScript,
    { CM_INITIAL_FOLDER: initial ?? '' },
    {
      timeout: 5 * 60 * 1000,
      signal,
    },
  )
}
