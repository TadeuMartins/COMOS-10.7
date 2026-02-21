/*
Deployment script for SchedulerDB

Please edit the following line and change ""SchedulerDB"" 
to the name of your existing database
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
:setvar DatabaseName "YourDatabase"
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
*/

GO
SET ANSI_NULLS, ANSI_PADDING, ANSI_WARNINGS, ARITHABORT, CONCAT_NULL_YIELDS_NULL, QUOTED_IDENTIFIER ON;

SET NUMERIC_ROUNDABORT OFF;


GO
:setvar DatabaseName "SchedulerDB"

GO
:on error exit
GO
/*
Detect SQLCMD mode and disable script execution if SQLCMD mode is not supported.
To re-enable the script after enabling SQLCMD mode, execute the following:
SET NOEXEC OFF; 
*/
:setvar __IsSqlCmdEnabled "True"
GO
IF N'$(__IsSqlCmdEnabled)' NOT LIKE N'True'
    BEGIN
        PRINT N'SQLCMD mode must be enabled to successfully execute this script.';
        SET NOEXEC ON;
    END

USE [$(DatabaseName)];


GO
PRINT N'Creating [scheduler]...';


GO
CREATE SCHEMA [scheduler]
    AUTHORIZATION [dbo];


GO
PRINT N'Creating [scheduler].[Users]...';


GO
CREATE TABLE [scheduler].[Users] (
    [Id]        INT            IDENTITY (1, 1) NOT NULL,
    [UID]       NVARCHAR (50)  NOT NULL,
    [FirstName] NVARCHAR (256) NULL,
    [LastName]  NVARCHAR (256) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [AK_UID] UNIQUE NONCLUSTERED ([UID] ASC)
);


GO
PRINT N'Creating [scheduler].[JobRequest]...';


GO
CREATE TABLE [scheduler].[JobRequest] (
    [Id]     INT            IDENTITY (1, 1) NOT NULL,
    [JobId]  INT            NOT NULL,
    [URI]    NVARCHAR (256) NOT NULL,
    [Method] NVARCHAR (256) NOT NULL,
    [Body]   NVARCHAR (MAX) NULL,
    PRIMARY KEY NONCLUSTERED ([Id] ASC),
    UNIQUE NONCLUSTERED ([JobId] ASC)
);


GO
PRINT N'Creating [scheduler].[JobLogs]...';


GO
CREATE TABLE [scheduler].[JobLogs] (
    [Id]          INT            IDENTITY (1, 1) NOT NULL,
    [JobId]       INT            NOT NULL,
    [ExecutionId] NVARCHAR (256) NOT NULL,
    [Content]     NVARCHAR (MAX) NULL,
    PRIMARY KEY NONCLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating [scheduler].[TempAttachments]...';


GO
CREATE TABLE [scheduler].[TempAttachments] (
    [Id]             UNIQUEIDENTIFIER NOT NULL,
    [Name]           NVARCHAR (256)   NOT NULL,
    [Size]           INT              NOT NULL,
    [UploadDatetime] DATETIME2 (7)    NULL,
    [Content]        VARBINARY (MAX)  NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating [scheduler].[Attachments]...';


GO
CREATE TABLE [scheduler].[Attachments] (
    [Id]             UNIQUEIDENTIFIER NOT NULL,
    [JobId]          INT              NOT NULL,
    [Name]           NVARCHAR (256)   NOT NULL,
    [Size]           INT              NOT NULL,
    [UploadDatetime] DATETIME2 (7)    NULL,
    [Content]        VARBINARY (MAX)  NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating [scheduler].[Version]...';


GO
CREATE TABLE [scheduler].[Version] (
    [DatabaseVersionMajor] INT NOT NULL,
    [DatabaseVersionMinor] INT NOT NULL,
    [DatabaseVersionPatch] INT NOT NULL,
    PRIMARY KEY CLUSTERED ([DatabaseVersionMajor] ASC)
);


GO
PRINT N'Creating [scheduler].[JobEntities]...';


GO
CREATE TABLE [scheduler].[JobEntities] (
    [Id]                INT            IDENTITY (1, 1) NOT NULL,
    [Name]            NVARCHAR (256) NOT NULL,
    [JobType]           NVARCHAR (256) NOT NULL,
    [Description]       NVARCHAR (256) NULL,
    [State]             NVARCHAR (256) NULL,
    [ChangedBy]         NVARCHAR (256) NULL,
    [ChangedDateTime]   DATETIME2 (7)  NOT NULL,
    [Priority]          INT            NULL,
    [CreatedBy]         NVARCHAR (256) NULL,
    [CreateDateTime]    DATETIME2 (7)  NOT NULL,
    [StartDateTime]     DATETIME2 (7)  NULL,
    [EndDateTime]       DATETIME2 (7)  NULL, 
    [StartedBy]         NVARCHAR(256)  NULL,
    [Completed]         BIT            NULL,
    [LogLevel]        INT            NULL,
    PRIMARY KEY NONCLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating unnamed constraint on [scheduler].[TempAttachments]...';


GO
ALTER TABLE [scheduler].[TempAttachments]
    ADD DEFAULT NEWID() FOR [Id];


GO
PRINT N'Creating unnamed constraint on [scheduler].[TempAttachments]...';


GO
ALTER TABLE [scheduler].[TempAttachments]
    ADD DEFAULT SYSDATETIME() FOR [UploadDatetime];


GO
PRINT N'Creating unnamed constraint on [scheduler].[Attachments]...';


GO
ALTER TABLE [scheduler].[Attachments]
    ADD DEFAULT NEWID() FOR [Id];


GO
PRINT N'Creating unnamed constraint on [scheduler].[Attachments]...';


GO
ALTER TABLE [scheduler].[Attachments]
    ADD DEFAULT SYSDATETIME() FOR [UploadDatetime];

	
GO
PRINT N'Creating unnamed constraint on [scheduler].[JobEntities]...';


GO
ALTER TABLE [scheduler].[JobEntities]
    ADD DEFAULT SYSDATETIME  ( ) FOR [ChangedDateTime];


GO
PRINT N'Creating unnamed constraint on [scheduler].[JobEntities]...';


GO
ALTER TABLE [scheduler].[JobEntities]
    ADD DEFAULT SYSDATETIME  ( ) FOR [CreateDateTime];


GO
PRINT N'Creating [scheduler].[sp_clear_temp_data]...';


GO
CREATE PROCEDURE [scheduler].[sp_clear_temp_data]
AS
	DELETE FROM [scheduler].[TempAttachments]; 
RETURN 0
GO
/*
Post-Deployment Script Template							
--------------------------------------------------------------------------------------
 This file contains SQL statements that will be appended to the build script.		
 Use SQLCMD syntax to include a file in the post-deployment script.			
 Example:      :r .\myfile.sql								
 Use SQLCMD syntax to reference a variable in the post-deployment script.		
 Example:      :setvar TableName MyTable							
               SELECT * FROM [$(TableName)]					
--------------------------------------------------------------------------------------
*/

BEGIN TRANSACTION
	IF EXISTS (SELECT TOP 1 * FROM [scheduler].[Version])
		DELETE FROM [scheduler].[Version]

	INSERT INTO [scheduler].[Version] (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (1,0,0)
COMMIT TRANSACTION
--:r .\Data\CreateJobs.sql
GO

GO
DECLARE @VarDecimalSupported AS BIT;

SELECT @VarDecimalSupported = 0;

IF ((ServerProperty(N'EngineEdition') = 3)
    AND (((@@microsoftversion / power(2, 24) = 9)
          AND (@@microsoftversion & 0xffff >= 3024))
         OR ((@@microsoftversion / power(2, 24) = 10)
             AND (@@microsoftversion & 0xffff >= 1600))))
    SELECT @VarDecimalSupported = 1;

IF (@VarDecimalSupported > 0)
    BEGIN
        EXECUTE sp_db_vardecimal_storage_format N'$(DatabaseName)', 'ON';
    END


GO
ALTER DATABASE [$(DatabaseName)]
    SET MULTI_USER 
    WITH ROLLBACK IMMEDIATE;


GO
PRINT N'Update complete.';


GO
