DECLARE @fromVersion varchar(15) = '1.0.0'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor,'.', DatabaseVersionPatch) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
	-- Add columns to TM_Comos_Related
		ALTER TABLE [dbo].[TM_Comos_Related]
			ADD ComosSystemType NVARCHAR(50) NULL
	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (1,0,1)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH;
END

SET @fromVersion = '1.0.1'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor,'.', DatabaseVersionPatch) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
	-- Add Link Table
		CREATE TABLE [dbo].[TM_Comos_Link]
		(
			[Id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
			[ComosDatabase] NVARCHAR(50) NOT NULL,
			[ComosProjId] NVARCHAR(50) NOT NULL,
			[ComosWoId] NVARCHAR(50) NULL,
			[ComosObjectUid] NVARCHAR(50) NOT NULL,
			[ComosSystemType] NVARCHAR(50) NULL,
			[Name] NVARCHAR(256) NULL,
			[Label] NVARCHAR(256) NULL,
			[Description] NVARCHAR(256) NULL
		)
	-- Add columns to TM_Comos_Related
		ALTER TABLE [dbo].[TM_Comos_Related]
			ADD [Name] NVARCHAR(256) NULL,
			[Label] NVARCHAR(256) NULL,
			[Description] NVARCHAR(256) NULL;
	-- Add ValueList Table
		CREATE TABLE [dbo].[TM_ValueLists]
		(
			[Id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
			[ParentId] INT NULL,
			[Name] NVARCHAR(256) NOT NULL,
			[Value] NVARCHAR(256) NOT NULL,
			[Description] NVARCHAR(256) NOT NULL ,
			[TranslationId] UNIQUEIDENTIFIER NULL,
			CONSTRAINT [FK_TM_ValueLists_ParentId] FOREIGN KEY (ParentId) REFERENCES [dbo].[TM_ValueLists]([Id]),
			CONSTRAINT [AK_TM_ValueLists_Name] UNIQUE ([Name], [ParentId])
		)
		--Create trigger on ValueList table
		EXEC('CREATE TRIGGER [dbo].[Trigger_TM_ValueList_Del]
			ON [dbo].[TM_ValueLists]
			INSTEAD OF DELETE
		AS
		BEGIN
			SET NoCount ON
			DELETE  FROM [dbo].[TM_ValueLists] WHERE ParentId IN (SELECT Id FROM deleted)
			DELETE  FROM [dbo].[TM_ValueLists] WHERE Id IN (SELECT Id FROM deleted)
		END')
	-- Change column for TM_Rules
		ALTER TABLE [dbo].[TM_Rules]
			ALTER COLUMN [RuleType] INT NOT NULL
	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (1,1,1)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH
END

-- Do these updates regardless of the patch version: 1.1.X
SET @fromVersion = '1.1'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
	-- Add columns to [TM_TaskLinks]
		ALTER TABLE [dbo].[TM_TaskLinks]
			ADD [Comment] NVARCHAR(255) NOT NULL DEFAULT '',
				[ChangedBy] INT NULL,
				[ChangedDateTime] DATETIME2 NULL

	-- Add columns to [TM_Attachments]
		ALTER TABLE [dbo].[TM_Attachments]
			ADD [Comment] NVARCHAR(255) NULL

	-- Change column for [TM_TaskEntities]
		ALTER TABLE [dbo].[TM_TaskEntities]
			ALTER COLUMN [ReferenceObject] NVARCHAR(256) NULL

	-- Add columns to [TM_LinkTypes]
		ALTER TABLE [dbo].[TM_LinkTypes]
			ADD [IsDirected] BIT NOT NULL DEFAULT 1

	-- Add columns to [TM_Comos_Related]
		ALTER TABLE [dbo].[TM_Comos_Related]
			ADD [IsSync] BIT NOT NULL DEFAULT 0

	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (2,0,0)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH
END

SET @fromVersion = '2.0.0'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor,'.', DatabaseVersionPatch) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
		-- Add constraint to TM_Attachments, TM_Comos_Related and TM_TaskLinks
		ALTER TABLE [dbo].[TM_Attachments]
			ADD CONSTRAINT [FK_TM_Attachments_TaskId] FOREIGN KEY ([TaskId]) REFERENCES [dbo].[TM_TaskEntities]([Id]) ON DELETE CASCADE;
        ALTER TABLE [dbo].[TM_Comos_Related]
			ADD CONSTRAINT [FK_TM_Comos_Related_TaskId] FOREIGN KEY ([TaskId]) REFERENCES [dbo].[TM_TaskEntities]([Id]) ON DELETE CASCADE;
        -- Add Instead of trigger for TM_TaskEntities table to delete entries on TM_TaskLinks table
        EXEC('CREATE TRIGGER [dbo].[Trigger_TM_TaskEntities_Del]
			ON [dbo].[TM_TaskEntities]
			INSTEAD OF DELETE
		AS
		BEGIN
			SET NoCount ON
			
            DELETE  T FROM [dbo].[TM_TaskLinks] T INNER JOIN deleted D ON D.Id = T.SourceTaskId

			DELETE  T FROM [dbo].[TM_TaskLinks] T INNER JOIN deleted D ON D.Id = T.TargetTaskId
            
            DELETE  T FROM [dbo].[TM_TaskEntities] T INNER JOIN deleted D ON D.Id = T.Id
		END')

	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (2,1,0)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH
END

SET @fromVersion = '2.1.0'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor, '.', DatabaseVersionPatch) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
	-- Change column for [TM_TaskEntities]
		ALTER TABLE [dbo].[TM_TaskEntities]
			ADD [DocumentNo] NVARCHAR(256) SPARSE  NULL,
            [Subject] NVARCHAR(256) SPARSE  NULL,
            [Keyword] NVARCHAR(256) SPARSE  NULL,
            [Role] NVARCHAR(256) SPARSE  NULL,
            [RequestForReject] NVARCHAR(256) SPARSE  NULL,
            [DocumentRevision] NVARCHAR(50) SPARSE  NULL,
            [DueDate] DATETIME2(7) SPARSE  NULL,
            [TaskCanceled] BIT SPARSE NULL,
            [TaskClosed] BIT SPARSE NULL,
            [Accept] BIT SPARSE NULL,
            [Reason] NVARCHAR(256) SPARSE  NULL,
            [TaskCompleted] BIT SPARSE NULL,
            [EditComment] NVARCHAR(MAX) SPARSE NULL,
            [Reject] BIT SPARSE NULL,
            [SignComment] NVARCHAR(256) SPARSE  NULL,
            [ReviewComments] NVARCHAR(MAX) SPARSE NULL

	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (2,2,0)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH
END

SET @fromVersion = '2.2.0'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor, '.', DatabaseVersionPatch) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
	-- Change column for [TM_TaskEntities]
		ALTER TABLE [dbo].[TM_TaskEntities]
			ADD DocumentStatus NVARCHAR(256) SPARSE  NULL,
            DocumentOwner NVARCHAR(256) SPARSE  NULL,
            WorkflowInstanceId NVARCHAR(256) SPARSE  NULL;

	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (2,3,0)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH
END

SET @fromVersion = '2.3.0'
IF @fromVersion = (SELECT CONCAT(DatabaseVersionMajor,'.', DatabaseVersionMinor, '.', DatabaseVersionPatch) FROM dbo.TM_Version)
BEGIN
	BEGIN TRY
	-- Change column for [TM_TaskEntities]
		ALTER TABLE [dbo].[TM_TaskEntities]
			ADD ComosTaskID INT  NULL,
            KindOfDocument NVARCHAR(256) SPARSE  NULL;

	-- Update version number
		Delete FROM dbo.TM_Version
		INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (2,4,0)
	END TRY
	BEGIN CATCH
		SELECT
			ERROR_NUMBER() AS ErrorNumber
			,ERROR_SEVERITY() AS ErrorSeverity
			,ERROR_STATE() AS ErrorState
			,ERROR_PROCEDURE() AS ErrorProcedure
			,ERROR_LINE() AS ErrorLine
			,ERROR_MESSAGE() AS ErrorMessage;
		PRINT 'Error update the Task Database, please contact the administrator.'
		RETURN
	END CATCH
END