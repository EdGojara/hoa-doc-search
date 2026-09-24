-- ============================================================================
-- LOPF: UNDO the retirement of PRIOR_SOURCE_IMPORT records
-- PREPARED, NOT RUN. Generated from prior_source_imports.manifest.json
-- (2026-09-24T13:21:30.526Z, ids sha256 b989af4b7e94c591).
-- ============================================================================
-- Restores exactly what retire_prior_source_imports.sql changed (and nothing
-- else): the listed entries back to 'posted', the AR batch back to 'committed'.
-- Run in the same transaction that removes the conversion posting, or the
-- balances will double.
DO $restore$
DECLARE
  v_ids uuid[] := ARRAY[
    '00101ac5-aca4-418e-928f-eb5b9113a511'::uuid,
    '00ddb972-745c-453b-83c7-f486b0dc1809'::uuid,
    '01a3d87a-8b0b-4363-a634-c52473b11f99'::uuid,
    '0204c642-eee8-4f8b-81a7-54dd73bc37c3'::uuid,
    '02f73d56-d9ad-45f8-ba5f-ef8c3d0e0787'::uuid,
    '036951dc-f5a2-449b-9bb1-0ed42a28c458'::uuid,
    '043a3047-dbc5-45ad-93bf-b58a4cfe1f29'::uuid,
    '06703d55-084d-467a-b835-f8bce82d1ee4'::uuid,
    '0721013f-ba73-4644-a3e2-436b3f51b64f'::uuid,
    '07497e3e-1692-4159-9ff1-c7c1fe88fa27'::uuid,
    '07853e3c-acab-4f18-9c09-4bd476b920c8'::uuid,
    '096bcb79-fffa-4f4a-9217-e15a8b207f3f'::uuid,
    '0c73c04c-e21a-4024-b3b7-6c47ca025252'::uuid,
    '0e8cba32-d3bd-41e1-a500-6874be57f883'::uuid,
    '0ecc3f96-718c-4424-ae5a-14ab85142142'::uuid,
    '102f039d-e2ba-4eb6-a38e-f819ad1e6766'::uuid,
    '1078e2c8-f6b3-487d-a6c5-505b1803d03d'::uuid,
    '11ae8a11-a86f-4b0c-b22f-5f26baddb784'::uuid,
    '182ff074-7ad1-426f-b27c-6a6277003cb2'::uuid,
    '1883b340-c78e-41fa-94c8-c23fd678a331'::uuid,
    '1fd6f3df-48a9-4798-982e-04f802d547b2'::uuid,
    '235a700d-65e7-473c-9289-806f8ceee955'::uuid,
    '23c5e6c6-138b-4201-bb45-93bab95137b7'::uuid,
    '26f2192e-5f4a-4cce-bcd8-36f58774ea2c'::uuid,
    '28d9525c-aac7-4522-8f50-a1672fec7f03'::uuid,
    '29403b13-9381-4dc1-a4e3-0330d2a537b7'::uuid,
    '29927b93-cb16-4de8-b47c-61298df5e259'::uuid,
    '2a1304a8-f032-4445-be04-4b84516c6da7'::uuid,
    '2af7f05e-3d8a-4fad-a240-7c3faa0249b6'::uuid,
    '2c4af0bc-d37e-4fdf-915b-cc84a1f64161'::uuid,
    '335d45fd-85db-485a-8d39-7ece6ee6899d'::uuid,
    '381ff770-b22e-44af-9c8d-1db34ddfe82c'::uuid,
    '3a7955ce-f9aa-4f98-b94e-2259ed0d6b15'::uuid,
    '3b465115-54b4-442e-b6d1-7f76bef6747b'::uuid,
    '3c3e5f5e-1bff-4256-9c09-b7a0e048f9b0'::uuid,
    '3c51726d-0c21-4336-94c2-3118d241d4ee'::uuid,
    '422e4251-d75b-4006-990f-4e8c2b35dd18'::uuid,
    '47ef2b87-164d-4466-bf54-03abfe6ef745'::uuid,
    '485c26d8-1d96-4c25-a662-ff42a4278fb1'::uuid,
    '4ef2c097-a7bc-46ba-aee8-dccc6df31e4b'::uuid,
    '512d4394-174d-482e-a2a9-e0af5ab91002'::uuid,
    '51dad7ef-1e31-4b9e-b7c0-96bf37664496'::uuid,
    '5362c22d-34ee-4fed-975b-019c62756248'::uuid,
    '54b83e99-ea6b-4cc5-89cf-0e09c97ea0b0'::uuid,
    '58ab2d9e-7410-422c-9d00-349e2f1d86ee'::uuid,
    '59c0eb66-a78c-4f2c-8137-ca7a3f372ff6'::uuid,
    '5d13a065-19cb-4014-adac-4080b28e8a73'::uuid,
    '5e3e3adf-521c-443f-9a2f-007fc4cce4d1'::uuid,
    '5e53f6e3-afd7-4c23-9a90-9f76f080f014'::uuid,
    '5f435d8e-ebc0-4aad-93d1-b0122f445c87'::uuid,
    '5ff4c787-defe-493a-8034-23ed2d7e6774'::uuid,
    '60574724-d53d-4b84-aed1-0c61c53e5d40'::uuid,
    '609d3dd6-9a68-47c1-ba06-57f1fd334760'::uuid,
    '60df6691-24dd-491b-afae-3082d0499270'::uuid,
    '61a4ffbc-3b83-4caa-9d77-43ef961e9ce2'::uuid,
    '65139309-1204-4cf7-a21f-54dc443d1fab'::uuid,
    '67f6b738-35e2-4cf2-95dd-3b0d9d50c892'::uuid,
    '6994442e-3876-4cc3-bec9-f0d1e3b2c15f'::uuid,
    '6a7ecade-b280-4a74-917e-dae5ee9f06c5'::uuid,
    '6cb8bda8-d281-4de6-9612-8f255f26a688'::uuid,
    '6d6165ba-249b-414a-bc0d-e8abf4b60332'::uuid,
    '6f68713d-0b8a-4a4b-b5af-459a1e49b1a1'::uuid,
    '70e11f65-d407-4428-8c8d-b2f3d2dafc6e'::uuid,
    '724c5f26-802d-4df6-ab8e-0b5205635e02'::uuid,
    '76d6456e-27a9-430f-8c4e-ce4a62351025'::uuid,
    '778aac9e-3ac4-4400-b105-1df5ee053e25'::uuid,
    '7969b1d2-cd97-4472-9004-69e8647fecc4'::uuid,
    '7aaa399f-4b5e-4874-836b-b74b43f78472'::uuid,
    '7bef86f8-efc7-4e24-a09e-8015f15fc7eb'::uuid,
    '7d05c0fb-d8d2-4c53-bfbe-59623490df12'::uuid,
    '7e673454-2b3f-4c19-bcec-496d55065055'::uuid,
    '826acf97-45c9-4f6d-89ad-50a3e805190f'::uuid,
    '838eb29a-dda9-41cd-8de0-f4dbae43be4b'::uuid,
    '83c43fad-9a3d-4ef4-b6a3-77aaa36ce397'::uuid,
    '85def49c-5412-42e8-a7eb-a12773f3c4a5'::uuid,
    '85e67bd3-fde6-4f39-ad25-6237b0761c28'::uuid,
    '87516b03-9f97-45bf-9262-e638eb0b4f80'::uuid,
    '8a91f5d2-1603-4bfc-aff5-e2b552587e02'::uuid,
    '8e58fa2e-7439-4445-b5ea-b4c127a52ac4'::uuid,
    '9351c91c-55d4-4008-a57f-4503cb217a94'::uuid,
    '93c624d7-266e-488d-950e-42a50079f4ef'::uuid,
    '96fc24d1-2602-46ba-92a3-835d04d01291'::uuid,
    '972b3997-63ef-466f-9ad6-f8e349e5f5c8'::uuid,
    'a2f826e1-170f-47a7-bc45-fe493a3fcac2'::uuid,
    'ab58877a-0dec-45f6-beda-d1b67c371d5f'::uuid,
    'b17819ed-9dd9-42d7-b897-e0ab340caff1'::uuid,
    'b5c7ea20-c238-425f-84b2-b18032aec20a'::uuid,
    'b6e15f7f-5bee-4c82-8084-29e4daad6f14'::uuid,
    'b71fe9e1-09b8-4518-8fb1-844c26e84ca0'::uuid,
    'b7d70a4a-c520-4a07-a855-08cf609623b0'::uuid,
    'b945b1d4-68dc-471e-b3bb-afa05d13a2a3'::uuid,
    'ba41d2cc-d145-41c0-9eb3-ae966f8c12f9'::uuid,
    'ba7b2406-7195-4a89-a8ff-86ef2efab8aa'::uuid,
    'bc043a07-e148-419b-a605-ac67444e5188'::uuid,
    'bca727cc-4421-4d7b-a68d-049979a26280'::uuid,
    'be70f6ef-2fb1-4083-a3f2-5f50d840141d'::uuid,
    'c065611b-5569-4e14-a1d5-5e5c727308b4'::uuid,
    'c16d3cee-f52e-4af3-8836-c3a1bf145aab'::uuid,
    'c16d8e77-dd40-4e25-b72b-32f7d1c1c828'::uuid,
    'c6757590-418c-400b-99e6-a4ef192940d8'::uuid,
    'c7fa0a99-d450-4d48-91e4-fa266c00d200'::uuid,
    'c86a96bb-1066-4a50-8b46-0747291d8afc'::uuid,
    'cad235a0-4ac8-45c6-b4f9-40d62d4ee664'::uuid,
    'ccc90415-0945-4c7e-b96b-a88f534391e5'::uuid,
    'cd390779-02ec-4365-81c5-964e32dac5e3'::uuid,
    'cf401dca-65a8-4d25-84ef-3e275916b667'::uuid,
    'cfffd52f-7b17-489c-9675-95288dede3da'::uuid,
    'd0e58ca8-e0c1-4c84-ae8f-3dfba1b94c01'::uuid,
    'd234aeb2-437e-4381-9924-f96ee037292b'::uuid,
    'd26c10ea-15fe-469a-b392-9357b3a82a12'::uuid,
    'd68e677a-43d1-4db2-8d83-5d3b2ee13e19'::uuid,
    'd6bbe553-06c8-4ef9-8c23-e7b9d6fa52d8'::uuid,
    'd7aff3a6-f16f-411f-9b1f-1233dce13f69'::uuid,
    'd8220950-8c14-4085-9bf5-df5c7713ce10'::uuid,
    'd9e16e51-095f-4bfd-aef3-080236b7b46e'::uuid,
    'da3f1e2a-0a47-4a41-9b92-c9604ac64d5e'::uuid,
    'da56a4cf-cc4f-4170-9581-16003f5883d7'::uuid,
    'dc5755db-2550-452e-8280-63b5ae42a058'::uuid,
    'dd9cef2f-f0ef-49b4-b936-d857dd2e1108'::uuid,
    'ddc96d9b-1698-44ec-bdf8-5a4439ce5ace'::uuid,
    'deb5c82f-3fee-4080-a9fe-1b7caca7bee4'::uuid,
    'e0a2da7c-f247-476e-8e36-43d8e84b4f39'::uuid,
    'e0b08ad2-e2ad-4c83-a4f8-42303b418e67'::uuid,
    'e1a5fc83-2454-4704-9112-fa61bb23fd50'::uuid,
    'e1e6f4a0-516a-4a19-bdaa-7ed2d202f6ca'::uuid,
    'e377beb0-aca5-4b17-96e8-95d4424a1bfb'::uuid,
    'e4393c25-72c1-42c6-a896-6156d5b64e7c'::uuid,
    'e56ef6ae-5631-412f-b2f9-883ce52562d1'::uuid,
    'e57c0840-8ab1-4bfe-83be-9f5dcec56109'::uuid,
    'e5ff8c84-c6f9-44bc-ac84-43e56cfefa24'::uuid,
    'e80a0d7f-6016-439b-8b7b-e48e95e364f8'::uuid,
    'ea6d2262-f63a-426a-bda3-b0c5d32ee736'::uuid,
    'ec056445-823e-4525-a0eb-12eeb2070ad0'::uuid,
    'edf83ac8-706b-4f9b-bce2-81084c14732b'::uuid,
    'ee0e16e5-bcf7-4fa8-afd3-6aa9cb512153'::uuid,
    'f0325764-c955-4fe6-811d-3eaf68d97795'::uuid,
    'f147f084-ee20-49f8-a56e-7f5103423753'::uuid,
    'f1630c68-7209-4e15-8d54-6cc083078a49'::uuid,
    'f30770b7-49b7-457e-8a07-461ab395ab6f'::uuid,
    'f3944893-1fb3-483e-a527-d985d6df10df'::uuid,
    'f49f5e95-388d-413f-8877-90f35148f44f'::uuid,
    'f631df76-b8f7-481f-b5e2-6e347579d9cf'::uuid,
    'f634efca-a166-4a21-8e56-7fcacdff7361'::uuid,
    'f7252aca-a587-42d1-8162-bca866616167'::uuid,
    'f741071a-4e7d-402b-91b5-f7a54b369b4a'::uuid,
    'f8be7e1b-fdf0-4b62-a893-ea5851d79b35'::uuid,
    'fa8abadf-13be-4131-b8ac-a7cf148a321e'::uuid
  ];
  n bigint; dr bigint; cr bigint;
BEGIN
  PERFORM 1 FROM journal_entries WHERE id = ANY(v_ids) FOR UPDATE;
  -- the exact set, unchanged since the manifest
  SELECT count(*), coalesce(sum(total_debits_cents),0), coalesce(sum(total_credits_cents),0)
    INTO n, dr, cr FROM journal_entries
   WHERE id = ANY(v_ids) AND community_id = 'a0000000-0000-4000-8000-000000000002';
  IF n <> 147 OR dr <> 295364655 OR cr <> 295364655 THEN
    RAISE EXCEPTION 'manifest mismatch: % entries, dr %, cr %', n, dr, cr;
  END IF;
  SELECT count(*) INTO n FROM journal_entry_lines WHERE journal_entry_id = ANY(v_ids);
  IF n <> 5759 THEN RAISE EXCEPTION 'line count % <> 5759', n; END IF;
  UPDATE journal_entries
     SET status = 'posted', superseded_at = NULL, superseded_reason = NULL, superseded_by_conversion = NULL
   WHERE id = ANY(v_ids) AND status = 'superseded' AND superseded_by_conversion = 'CONV-LPF-20260731';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 147 THEN RAISE EXCEPTION 'restored % entries, expected 147', n; END IF;
  UPDATE transaction_upload_batches
     SET status = 'committed', reverted_at = NULL, reverted_reason = NULL, replaced_by_batch_id = NULL
   WHERE id = 'c732b43c-57e7-4aba-b6f8-90076036515a' AND status = 'reverted' AND reverted_reason LIKE 'PRIOR_SOURCE_IMPORT retired%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'AR batch not restored'; END IF;
END
$restore$;
