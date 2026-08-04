from fastapi import APIRouter, File, HTTPException, UploadFile

router = APIRouter()


@router.post("/")
async def scan_receipt(image: UploadFile = File(...)) -> dict:
    """Line-item OCR: split one long receipt image into per-line entries.

    TODO: send `image` to Google Cloud Vision's Document Text Detection,
    parse the response into one entry per receipt line (raw text + price),
    and return them for the /match endpoint to standardize.
    """
    raise HTTPException(status_code=501, detail="OCR integration not implemented yet")
