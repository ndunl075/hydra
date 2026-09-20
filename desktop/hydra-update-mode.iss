// Included at the start of the pinned [Code] section. This is an installer
// refusal boundary; the signed native helper remains the install authority.
function HydraUpdateSwitchState(): Integer;
var
  I, Seen: Integer;
  Arg: String;
begin
  Seen := 0;
  Result := 0;
  for I := 1 to ParamCount() do begin
    Arg := UpperCase(ParamStr(I));
    if Pos('/HYDRAUPDATE', Arg) = 1 then begin
      if Arg <> '/HYDRAUPDATE=1' then begin
        Result := -1;
        Exit;
      end;
      Seen := Seen + 1;
    end;
  end;
  if Seen > 1 then Result := -1
  else if Seen = 1 then Result := 1;
end;

function IsHydraUpdate(): Boolean;
begin
  Result := HydraUpdateSwitchState() = 1;
end;

function HydraHasSwitch(Name: String): Boolean;
var
  I: Integer;
  Arg: String;
begin
  Result := False;
  for I := 1 to ParamCount() do begin
    Arg := UpperCase(ParamStr(I));
    if (Arg = Name) or (Pos(Name + '=', Arg) = 1) then begin
      Result := True;
      Exit;
    end;
  end;
end;

function HydraHasExactSwitch(Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount() do begin
    if UpperCase(ParamStr(I)) = Name then begin
      Result := True;
      Exit;
    end;
  end;
end;

function HydraUpdateArgumentsValid(): Boolean;
begin
  Result := True;
  if not IsHydraUpdate() then Exit;
  Result := WizardSilent() and HydraHasExactSwitch('/NORESTART')
    and not HydraHasSwitch('/CLOSEAPPLICATIONS')
    and not HydraHasSwitch('/FORCECLOSEAPPLICATIONS')
    and not HydraHasSwitch('/RESTARTAPPLICATIONS')
    and not HydraHasSwitch('/TASKS')
    and not HydraHasSwitch('/MERGETASKS')
    and not HydraHasSwitch('/LOADINF');
end;

function HydraStableVersion(S: String): Boolean;
var
  I, Dots, SegmentStart: Integer;
begin
  Result := False;
  Dots := 0;
  SegmentStart := 1;
  if Length(S) = 0 then Exit;
  for I := 1 to Length(S) do begin
    if S[I] = '.' then begin
      if (I = SegmentStart) or (Dots = 2) or
        ((I - SegmentStart > 1) and (S[SegmentStart] = '0')) then Exit;
      Dots := Dots + 1;
      SegmentStart := I + 1;
    end else if (S[I] < '0') or (S[I] > '9') then Exit;
  end;
  Result := (Dots = 2) and (SegmentStart <= Length(S)) and
    ((Length(S) - SegmentStart = 0) or (S[SegmentStart] <> '0'));
end;

function HydraCheckInstall(): String;
var
  UserKey, SystemKey, RegisteredDir, DisplayVersion, DisplayName, DestDir: String;
  Candidate, Existing: Int64;
begin
  Result := '';
  UserKey := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Copy('{#AppId}', 2, 38) + '_is1';
  SystemKey := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Copy('{#IncompatibleTargetAppId}', 2, 38) + '_is1';
  DestDir := RemoveBackslashUnlessRoot(ExpandFileName(ExpandConstant('{app}')));
  if not HydraStableVersion('{#Version}') or not StrToVersion('{#RawVersion}', Candidate) then begin
    Result := 'This installer has no stable Hydra release version.';
    Exit;
  end;
  if RegKeyExists(HKLM64, SystemKey) then begin
    Result := 'A system Hydra installation is registered. The user installer will not replace it.';
    Exit;
  end;
  if RegKeyExists(HKCU64, UserKey) then begin
    if not RegQueryStringValue(HKCU64, UserKey, 'Inno Setup: App Path', RegisteredDir) or
      not RegQueryStringValue(HKCU64, UserKey, 'DisplayVersion', DisplayVersion) or
      not RegQueryStringValue(HKCU64, UserKey, 'DisplayName', DisplayName) then begin
      Result := 'The existing Hydra installation record is incomplete.';
      Exit;
    end;
    if (DisplayName <> '{#NameLong}') or (RegisteredDir = '') or
      (CompareText(RemoveBackslashUnlessRoot(ExpandFileName(RegisteredDir)), DestDir) <> 0) or
      not FileExists(AddBackslash(RegisteredDir) + '{#ExeBasename}.exe') then begin
      Result := 'The existing Hydra installation identity or destination differs.';
      Exit;
    end;
    if not HydraStableVersion(DisplayVersion) or not StrToVersion(DisplayVersion, Existing) then begin
      Result := 'The installed Hydra version cannot be compared safely.';
      Exit;
    end;
    if ComparePackedVersion(Existing, Candidate) >= 0 then begin
      Result := 'Hydra refuses equal-version and downgrade installs. Repair needs separate authorization.';
      Exit;
    end;
  end else begin
    if IsHydraUpdate() then begin
      Result := 'A Hydra update requires an existing registered user installation.';
      Exit;
    end;
    if DirExists(DestDir) then begin
      Result := 'The destination already exists without a matching Hydra installation record.';
      Exit;
    end;
  end;
end;
