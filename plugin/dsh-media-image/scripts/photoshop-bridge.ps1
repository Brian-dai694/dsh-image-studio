param(
  [Parameter(Mandatory = $true)] [ValidateSet('status','open_image','create_document','place_image','add_text_layer','layer_ops','adjust_image','export_active','run_jsx')] [string]$Action,
  [string]$ProgId,
  [int]$TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
function Write-Result($value) { $value | ConvertTo-Json -Depth 10 -Compress | Write-Output }
function Js-Literal($value) { ConvertTo-Json -InputObject $value -Depth 10 -Compress }
function Get-App {
  $candidates = @(); if ($ProgId) { $candidates += $ProgId }; if ($env:PHOTOSHOP_PROG_ID) { $candidates += $env:PHOTOSHOP_PROG_ID }
  $candidates += @('Photoshop.Application','Photoshop.Application.BETA','Photoshop.Application.BETA.1','Photoshop.Application.2026','Photoshop.Application.2025','Photoshop.Application.2024','Photoshop.Application.2023','Photoshop.Application.Beta')
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    try { return @{ app = [Runtime.InteropServices.Marshal]::GetActiveObject($candidate); progId = $candidate; attached = $true } } catch {
      try { return @{ app = New-Object -ComObject $candidate; progId = $candidate; attached = $false } } catch { }
    }
  }
  throw 'Could not connect to Photoshop COM. Start Photoshop and verify COM registration/ProgID.'
}
function Doc-Info($app) {
  if ($app.Documents.Count -lt 1) { return @{ documentCount = 0; appVersion = [string]$app.Version } }
  $doc = $app.ActiveDocument
  return @{ documentCount = [int]$app.Documents.Count; appVersion = [string]$app.Version; activeDocument = @{ name = [string]$doc.Name; widthPx = [double]$doc.Width; heightPx = [double]$doc.Height; resolution = [double]$doc.Resolution; mode = [string]$doc.Mode } }
}
try {
  $raw = [Console]::In.ReadToEnd()
  $args = $raw | ConvertFrom-Json
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 300) { throw 'TimeoutSeconds out of range.' }
  if ($Action -eq 'status') {
    $connection = Get-App
    Write-Result @{ ok = $true; progId = $connection.progId; attached = $connection.attached; result = (Doc-Info $connection.app) }
    exit 0
  }
  $connection = Get-App
  $app = $connection.app
  # run_jsx: the caller's ExtendScript is handed to DoJavaScript verbatim.
  # This branch deliberately does NOT go through Js-Literal or a here-string, so $, "
  # and backticks inside the script are data, never PowerShell expansions.
  # Keep this file pure ASCII: powershell.exe reads BOM-less scripts as ANSI, and
  # non-ASCII comments here have already broken parsing once.
  if ($Action -eq 'run_jsx') {
    $script = [string]$args.jsx
    if ([string]::IsNullOrWhiteSpace($script)) { throw 'jsx is empty.' }
    $result = $app.DoJavaScript($script)
    Write-Result @{ ok = $true; action = $Action; progId = $connection.progId; attached = $connection.attached; result = $result; document = (Doc-Info $app) }
    exit 0
  }
  $p = Js-Literal $args
  $jsx = switch ($Action) {
    'open_image' { @"
var p = $p; var f = new File(p.path); if (!f.exists) throw new Error('Input image does not exist'); app.open(f); 'opened';
"@ }
    'create_document' { @"
var p = $p; var d = app.documents.add(UnitValue(p.widthPx,'px'),UnitValue(p.heightPx,'px'),Number(p.resolution||72),String(p.name||'DSH document'),NewDocumentMode.RGB,p.transparent?DocumentFill.TRANSPARENT:DocumentFill.WHITE); 'created';
"@ }
    'place_image' { @"
var p = $p; var f = new File(p.imagePath); if (!f.exists) throw new Error('Image file does not exist'); var d=app.activeDocument; var old=d.activeLayer; app.open(f); var src=app.activeDocument; src.activeLayer.duplicate(d,ElementPlacement.PLACEATBEGINNING); src.close(SaveOptions.DONOTSAVECHANGES); d=app.documents.getByName(d.name); d.activeLayer.name=String(p.layerName||'Placed image'); if(p.opacity!==undefined)d.activeLayer.opacity=Number(p.opacity); if(p.blendMode)d.activeLayer.blendMode=BlendMode[String(p.blendMode).toUpperCase()]||BlendMode.NORMAL; 'placed';
"@ }
    'add_text_layer' { @"
var p = $p; var d=app.activeDocument; var l=d.artLayers.add(); l.kind=LayerKind.TEXT; l.name=String(p.layerName||'Text'); l.textItem.contents=String(p.text); l.textItem.position=[UnitValue(Number(p.xPx),'px'),UnitValue(Number(p.yPx),'px')]; l.textItem.size=UnitValue(Number(p.sizePx||36),'px'); l.textItem.color.rgb.red=parseInt(String(p.color||'#ffffff').substr(1,2),16); l.textItem.color.rgb.green=parseInt(String(p.color||'#ffffff').substr(3,2),16); l.textItem.color.rgb.blue=parseInt(String(p.color||'#ffffff').substr(5,2),16); 'text added';
"@ }
    'layer_ops' { @"
var p=$p; var d=app.activeDocument; var found=null; for(var i=0;i<d.layers.length;i++){if(d.layers[i].name===p.layerName){found=d.layers[i];break;}} if(p.operation==='list'){var a=[];for(var j=0;j<d.layers.length;j++)a.push({name:d.layers[j].name,visible:d.layers[j].visible,opacity:d.layers[j].opacity});JSON.stringify(a);}else{if(!found)throw new Error('Layer not found: '+p.layerName);if(p.operation==='rename')found.name=p.newName;else if(p.operation==='show')found.visible=true;else if(p.operation==='hide')found.visible=false;else if(p.operation==='setOpacity')found.opacity=Number(p.opacity);else if(p.operation==='setBlendMode')found.blendMode=BlendMode[String(p.blendMode).toUpperCase()]||BlendMode.NORMAL;'layer updated';}
"@ }
    'adjust_image' { @"
var p=$p; if(p.inputPath){var f=new File(p.inputPath);if(!f.exists)throw new Error('Input image does not exist');app.open(f);} var d=app.activeDocument;if(p.widthPx||p.heightPx)d.resizeImage(p.widthPx?UnitValue(Number(p.widthPx),'px'):null,p.heightPx?UnitValue(Number(p.heightPx),'px'):null,null,ResampleMethod.BICUBIC); if(p.brightness!==undefined||p.contrast!==undefined)d.activeLayer.adjustBrightnessContrast(Number(p.brightness||0),Number(p.contrast||0));if(p.sharpen)d.activeLayer.applyUnSharpMask(50,1,0); if(p.outputPath){var o=new File(p.outputPath);if(o.exists)throw new Error('Refusing to overwrite existing output');var e=o.name.toLowerCase().match(/\.([^.]+)$/);if(!e)throw new Error('Output path needs an extension');if(e[1]==='png')d.saveAs(o,new PNGSaveOptions(),true,Extension.LOWERCASE);else if(e[1]==='jpg'||e[1]==='jpeg'){var jo=new JPEGSaveOptions();jo.quality=Number(p.jpegQuality||10);d.saveAs(o,jo,true,Extension.LOWERCASE);}else throw new Error('Only PNG/JPEG output supported');}'adjusted';
"@ }
    'export_active' { @"
var p=$p; var o=new File(p.outputPath);if(o.exists)throw new Error('Refusing to overwrite existing output');var e=o.name.toLowerCase().match(/\.([^.]+)$/);if(!e)throw new Error('Output path needs an extension');var d=app.activeDocument;if(e[1]==='png')d.saveAs(o,new PNGSaveOptions(),true,Extension.LOWERCASE);else if(e[1]==='jpg'||e[1]==='jpeg'){var jo=new JPEGSaveOptions();jo.quality=Number(p.jpegQuality||10);d.saveAs(o,jo,true,Extension.LOWERCASE);}else if(e[1]==='psd')d.saveAs(o,new PhotoshopSaveOptions(),true,Extension.LOWERCASE);else if(e[1]==='tif'||e[1]==='tiff')d.saveAs(o,new TiffSaveOptions(),true,Extension.LOWERCASE);else throw new Error('Unsupported output extension');'exported';
"@ }
  }
  $result = $app.DoJavaScript([string]$jsx)
  Write-Result @{ ok = $true; action = $Action; progId = $connection.progId; attached = $connection.attached; result = $result; document = (Doc-Info $app) }
  exit 0
} catch {
  Write-Result @{ ok = $false; action = $Action; error = $_.Exception.Message }
  exit 1
} finally {
  if ($app) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { } }
}
